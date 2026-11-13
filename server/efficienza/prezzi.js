import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing'
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer'
import { clientOpts } from '../runtime/awsClient.js'
import { cached } from '../util/ttlcache.js'

// Prezzi di LISTINO dalla Pricing API di AWS, per la regione di ogni account. Servono a dire quanto
// costa una taglia che oggi non paghiamo (la taglia giusta, la classe sotto del database): la fattura
// di Cost Explorer sa solo quello che c'è. Il listino non è la fattura (crediti, sconti, Savings Plan):
// la pagina lo dice e mostra il netto a parte. Permesso: `pricing:GetProducts`. La Pricing API vive in
// us-east-1 (risponde anche per le altre regioni) ed è gratuita.

const GIORNO = 24 * 60 * 60 * 1000

// Il prezzo orario in USD di un prodotto della Pricing API (una stringa JSON per prodotto).
export function prezzoOnDemand(prodotto) {
  const p = typeof prodotto === 'string' ? JSON.parse(prodotto) : prodotto
  for (const termine of Object.values(p?.terms?.OnDemand ?? {})) {
    for (const d of Object.values(termine?.priceDimensions ?? {})) {
      const usd = Number(d?.pricePerUnit?.USD)
      if (Number.isFinite(usd) && usd > 0) return usd
    }
  }
  return null
}

// Fargate: i prodotti di AmazonECS di una regione, riconosciuti dal SUFFISSO dello usagetype
// (`EUC1-Fargate-vCPU-Hours:perCPU`): il prefisso è il codice della regione, e leggerlo dal suffisso
// evita una tabella regione→prefisso scritta a mano. Puro: prende la lista già scaricata.
const SUFFISSI = {
  vcpu: /-Fargate-vCPU-Hours:perCPU$/,
  gb: /-Fargate-GB-Hours$/,
  armVcpu: /-Fargate-ARM-vCPU-Hours:perCPU$/,
  armGb: /-Fargate-ARM-GB-Hours$/,
}
export function prezziFargateDa(prodotti) {
  const out = {}
  for (const raw of prodotti ?? []) {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw
    const tipo = p?.product?.attributes?.usagetype ?? ''
    for (const [k, re] of Object.entries(SUFFISSI)) {
      if (out[k] == null && re.test(tipo)) out[k] = prezzoOnDemand(p)
    }
  }
  if (!out.vcpu || !out.gb) return null
  return {
    x86: { vcpu: out.vcpu, gb: out.gb, spotVcpu: out.spotVcpu ?? null, spotGb: out.spotGb ?? null },
    // Fargate Spot non è nel listino (il prezzo cambia): lo aggiunge `conSpot` dalla spesa vera.
    arm: out.armVcpu && out.armGb ? { vcpu: out.armVcpu, gb: out.armGb, spotVcpu: null, spotGb: null } : null,
  }
}

// La tariffa Spot effettiva, da Cost Explorer: costo diviso ore d'uso delle voci Spot di ECS negli
// ultimi 30 giorni. Un account che non usa Spot non ha tariffa (null) e la leva Spot non si propone:
// meglio nessuna proposta che una calcolata su un prezzo inventato. Puro sui gruppi già scaricati.
export function tariffeSpotDa(gruppi) {
  const somma = { vcpu: [0, 0], gb: [0, 0] }
  for (const g of gruppi ?? []) {
    const tipo = g.Keys?.[0] ?? ''
    if (!/Spot/i.test(tipo) || /Ephemeral/i.test(tipo)) continue
    const k = /vCPU/i.test(tipo) ? 'vcpu' : /GB-Hours/i.test(tipo) ? 'gb' : null
    if (!k) continue
    somma[k][0] += Number(g.Metrics?.UnblendedCost?.Amount ?? 0)
    somma[k][1] += Number(g.Metrics?.UsageQuantity?.Amount ?? 0)
  }
  const tariffa = ([costo, ore]) => (ore > 0 && costo > 0 ? costo / ore : null)
  return { vcpu: tariffa(somma.vcpu), gb: tariffa(somma.gb) }
}

export function tariffeSpot(aws) {
  return cached(`prezzi:spot:${aws.roleArn ?? aws.profile ?? 'self'}`, 60 * 60 * 1000, async () => {
    const fine = new Date()
    const inizio = new Date(fine.getTime() - 30 * GIORNO)
    const giorno = (d) => d.toISOString().slice(0, 10)
    const ce = new CostExplorerClient(clientOpts({ ...aws, region: 'us-east-1' }))
    const r = await ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: giorno(inizio), End: giorno(fine) },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost', 'UsageQuantity'],
        Filter: {
          And: [
            { Dimensions: { Key: 'SERVICE', Values: ['Amazon Elastic Container Service'] } },
            { Dimensions: { Key: 'RECORD_TYPE', Values: ['Usage'] } },
          ],
        },
        GroupBy: [{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
      }),
    )
    return tariffeSpotDa(r.ResultsByTime?.flatMap((x) => x.Groups ?? []))
  })
}

// Il listino con la tariffa Spot effettiva dentro. Su ARM la stessa proporzione Spot/pieno di x86.
export function conSpot(prezzi, spot) {
  if (!prezzi || !spot?.vcpu || !spot?.gb) return prezzi
  const x86 = { ...prezzi.x86, spotVcpu: spot.vcpu, spotGb: spot.gb }
  const arm = prezzi.arm ? { ...prezzi.arm, spotVcpu: (spot.vcpu * prezzi.arm.vcpu) / prezzi.x86.vcpu, spotGb: (spot.gb * prezzi.arm.gb) / prezzi.x86.gb } : null
  return { x86, arm }
}

async function prodotti(aws, ServiceCode, Filters) {
  const client = new PricingClient(clientOpts({ ...aws, region: 'us-east-1' }))
  const out = []
  let NextToken
  let pagine = 0
  do {
    const res = await client.send(
      new GetProductsCommand({
        ServiceCode,
        Filters: Filters.map(([Field, Value]) => ({ Type: 'TERM_MATCH', Field, Value })),
        MaxResults: 100,
        NextToken,
      }),
    )
    out.push(...(res.PriceList ?? []))
    NextToken = res.NextToken
  } while (NextToken && ++pagine < 20)
  return out
}

export function prezziFargate(aws, region) {
  return cached(`prezzi:fargate:${region}`, GIORNO, async () =>
    prezziFargateDa(await prodotti(aws, 'AmazonECS', [['regionCode', region]])),
  )
}

// Motore RDS → nome nella Pricing API. È il vocabolario di AWS, non una scelta nostra.
const MOTORI = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  'aurora-postgresql': 'Aurora PostgreSQL',
  'aurora-mysql': 'Aurora MySQL',
}

// Prezzo orario di un'istanza RDS. Più prodotti possono combaciare (licenze, I/O-Optimized): vale il
// più basso, che è la configurazione standard. Ritorna null se la classe non ha un prezzo leggibile.
export function prezzoRds(aws, { region, classe, motore, multiAz }) {
  const nome = MOTORI[motore]
  if (!nome || !classe) return Promise.resolve(null)
  const aurora = motore.startsWith('aurora')
  return cached(`prezzi:rds:${region}:${classe}:${motore}:${multiAz ? 'multi' : 'single'}`, GIORNO, async () => {
    const lista = await prodotti(aws, 'AmazonRDS', [
      ['regionCode', region],
      ['instanceType', classe],
      ['databaseEngine', nome],
      ['deploymentOption', aurora || !multiAz ? 'Single-AZ' : 'Multi-AZ'],
    ])
    const prezzi = lista.map(prezzoOnDemand).filter((x) => x != null)
    return prezzi.length ? Math.min(...prezzi) : null
  })
}

// Tipo di disco RDS → nome nella Pricing API (vocabolario di AWS).
const DISCHI = {
  gp3: 'General Purpose-GP3',
  gp2: 'General Purpose',
  io1: 'Provisioned IOPS',
  io2: 'Provisioned IOPS-IO2',
  standard: 'Magnetic',
  aurora: 'General Purpose-Aurora',
  'aurora-iopt1': 'IO Optimized-Aurora',
}

// Prezzo al GB-mese del disco di un database: serve a dare un valore in dollari allo spazio sprecato
// (indici mai usati, righe morte). Null se non si legge.
export function prezzoDiscoRds(aws, { region, motore, tipoDisco, multiAz }) {
  const nome = MOTORI[motore]
  const aurora = String(motore).startsWith('aurora')
  const volume = DISCHI[tipoDisco ?? (aurora ? 'aurora' : 'gp3')]
  if (!nome || !volume) return Promise.resolve(null)
  return cached(`prezzi:disco:${region}:${motore}:${volume}:${multiAz ? 'multi' : 'single'}`, GIORNO, async () => {
    const lista = await prodotti(aws, 'AmazonRDS', [
      ['regionCode', region],
      ['productFamily', 'Database Storage'],
      ['databaseEngine', nome],
      ['volumeType', volume],
      ['deploymentOption', aurora || !multiAz ? 'Single-AZ' : 'Multi-AZ'],
    ])
    const prezzi = lista.map(prezzoOnDemand).filter((x) => x != null)
    return prezzi.length ? Math.min(...prezzi) : null
  })
}
