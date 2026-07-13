import {
  EC2Client,
  DescribeAddressesCommand,
  DescribeNatGatewaysCommand,
  DescribeVolumesCommand,
  DescribeInstancesCommand,
} from '@aws-sdk/client-ec2'
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds'
import { clientOpts } from './runtime/awsClient.js'
import { metricValues } from './runtime/cw.js'

// #10 — Sprechi: risorse a costo che spesso restano orfane. Read-only (EC2 Describe).
// Stime mensili APPROSSIMATIVE (USD, eu-central-1) solo per dare un ordine di grandezza.
const EIP_MO = 3.6 // Elastic IP non associato (~$0.005/h)
const NAT_MO = 32 // NAT Gateway (~$0.045/h, banda esclusa)
const GB_MO = 0.08 // EBS gp3 ~$0.08/GB/mese

// Sprechi "istanziati ma non usati": risorse ACCESE ma di fatto ferme (nessun costo staccato, ma le
// paghi mentre girano a vuoto). Deterministico via CloudWatch (nessuna ML, coerente con l'ethos no-LLM):
// media/max di una metrica su una finestra. Le risorse troppo giovani si ignorano (dati insufficienti →
// sembrerebbero sempre idle appena create).
const IDLE_WINDOW_MIN = 7 * 24 * 60 // 7 giorni
const MIN_AGE_DAYS = 3 // sotto quest'età i dati non bastano per dire "ferma"
const CPU_IDLE_PCT = 2 // EC2 accesa ma CPU media < 2% → praticamente a vuoto
const CONN_IDLE_AVG = 1 // DB con connessioni MEDIE < 1 → nessuno lo usa (reader Aurora idle ~0.05)

const DAY_MS = 86_400_000
const ageDays = (d) => (d ? (Date.now() - new Date(d).getTime()) / DAY_MS : 0)
const round1 = (n) => Math.round(n * 10) / 10

// Decisione pura/testabile: segnala "accesa ma ferma" solo se la risorsa è abbastanza vecchia da avere
// dati significativi E la metrica è sotto (o pari a) la soglia. Pura → unit-testabile senza AWS.
export function isIdle({ ageDays: age, metric, threshold }) {
  return age >= MIN_AGE_DAYS && metric <= threshold
}

// EC2 running con CPU media ~0 sulla finestra. Best-effort per-istanza: se la metrica non è leggibile
// (permesso/metrica assente) quella istanza si salta, non fa cadere l'intera lista.
async function findIdleInstances(aws) {
  const ec2 = new EC2Client(clientOpts(aws))
  const reservations = []
  let tok
  do {
    const r = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [{ Name: 'instance-state-name', Values: ['running'] }],
        NextToken: tok,
      }),
    )
    reservations.push(...(r.Reservations ?? []))
    tok = r.NextToken
  } while (tok)
  const instances = reservations.flatMap((r) => r.Instances ?? [])
  const checked = await Promise.all(
    instances.map(async (i) => {
      try {
        const age = ageDays(i.LaunchTime)
        if (age < MIN_AGE_DAYS) return null
        // utilizzo CPU = quanta della capacità di calcolo usa: media (quanto lavora di solito) + picco.
        const { cpuAvg, cpuMax } = await metricValues(
          aws,
          'AWS/EC2',
          [{ Name: 'InstanceId', Value: i.InstanceId }],
          [
            ['cpuAvg', 'CPUUtilization', 'Average'],
            ['cpuMax', 'CPUUtilization', 'Maximum'],
          ],
          IDLE_WINDOW_MIN,
        )
        if (!isIdle({ ageDays: age, metric: cpuAvg, threshold: CPU_IDLE_PCT })) return null
        return { id: i.InstanceId, type: i.InstanceType, cpuAvg: round1(cpuAvg), cpuMax: round1(cpuMax) }
      } catch {
        return null
      }
    }),
  )
  return checked.filter(Boolean)
}

// DB (RDS/Aurora) "available" con 0 connessioni sulla finestra. NB può essere una replica di lettura o
// un nodo HA voluto → in UI è "da verificare", non "spreco" certo.
async function findIdleDatabases(aws) {
  const rds = new RDSClient(clientOpts(aws))
  const dbs = []
  let marker
  do {
    const r = await rds.send(new DescribeDBInstancesCommand({ Marker: marker }))
    dbs.push(...(r.DBInstances ?? []))
    marker = r.Marker
  } while (marker)
  const checked = await Promise.all(
    dbs
      .filter((d) => d.DBInstanceStatus === 'available')
      .map(async (d) => {
        try {
          const age = ageDays(d.InstanceCreateTime)
          if (age < MIN_AGE_DAYS) return null
          // Rilevamento su connessioni MEDIE quasi nulle (un Maximum>0 sporadico da health-check non
          // basta a dire "usato"); mostriamo l'utilizzo CPU (media + picco) = quanta capacità usa davvero.
          const { conn, cpuAvg, cpuMax } = await metricValues(
            aws,
            'AWS/RDS',
            [{ Name: 'DBInstanceIdentifier', Value: d.DBInstanceIdentifier }],
            [
              ['conn', 'DatabaseConnections', 'Average'],
              ['cpuAvg', 'CPUUtilization', 'Average'],
              ['cpuMax', 'CPUUtilization', 'Maximum'],
            ],
            IDLE_WINDOW_MIN,
          )
          if (!isIdle({ ageDays: age, metric: conn, threshold: CONN_IDLE_AVG })) return null
          return { id: d.DBInstanceIdentifier, class: d.DBInstanceClass, cpuAvg: round1(cpuAvg), cpuMax: round1(cpuMax) }
        } catch {
          return null
        }
      }),
  )
  return checked.filter(Boolean)
}

export async function findWaste({ profile, roleArn, externalId, region, ignore = [] }) {
  const aws = { profile, roleArn, externalId, region }
  const ec2 = new EC2Client(clientOpts(aws))

  // NAT e Volumi paginano (NextToken): senza il loop si perdono le risorse oltre la prima pagina
  // → sprechi sottostimati. DescribeAddresses non pagina (ritorna tutti gli EIP in una volta).
  const collectNat = async () => {
    const out = []
    let tok
    do {
      const r = await ec2.send(
        new DescribeNatGatewaysCommand({ Filter: [{ Name: 'state', Values: ['available'] }], NextToken: tok }),
      )
      out.push(...(r.NatGateways ?? []))
      tok = r.NextToken
    } while (tok)
    return out
  }
  const collectVol = async () => {
    const out = []
    let tok
    do {
      const r = await ec2.send(
        new DescribeVolumesCommand({ Filters: [{ Name: 'status', Values: ['available'] }], NextToken: tok }),
      )
      out.push(...(r.Volumes ?? []))
      tok = r.NextToken
    } while (tok)
    return out
  }

  // Ogni ricerca è best-effort e indipendente: un permesso mancante (es. rds/cloudwatch) svuota SOLO
  // la sua categoria, non l'intera pagina.
  const [addrs, nats, vols, idleInstances, idleDatabases] = await Promise.all([
    ec2.send(new DescribeAddressesCommand({})).catch(() => ({ Addresses: [] })),
    collectNat().catch(() => []),
    collectVol().catch(() => []),
    findIdleInstances(aws).catch(() => []),
    findIdleDatabases(aws).catch(() => []),
  ])

  // Allow-list: risorse "note e volute" (es. un reader HA) marcate in services.yaml (`wasteIgnore`) →
  // non le contiamo come spreco. Match per id (EIP anche per IP), così è facile da scrivere a mano.
  const ig = new Set(ignore ?? [])
  const kept = (x) => !ig.has(x.id)

  // EIP senza AssociationId = non agganciato a nulla → spreco netto.
  const eips = (addrs.Addresses ?? [])
    .filter((a) => !a.AssociationId)
    .map((a) => ({ id: a.AllocationId, ip: a.PublicIp }))
    .filter((e) => !ig.has(e.id) && !ig.has(e.ip))
  const natGateways = nats.map((n) => ({ id: n.NatGatewayId, vpc: n.VpcId })).filter(kept)
  // Volumi in stato "available" = staccati da ogni istanza → spreco.
  const volumes = vols.map((v) => ({ id: v.VolumeId, sizeGb: v.Size ?? 0 })).filter(kept)

  // Il totale in $ resta la spesa FISSA a listino (EIP/NAT/EBS orfani): quella la sai al centesimo.
  // Le risorse "accese ma ferme" hanno un costo che dipende dal tipo/dalla tariffa → niente stima secca,
  // sono elencate come "da verificare".
  const estMonthlyUsd = Math.round(
    eips.length * EIP_MO +
      natGateways.length * NAT_MO +
      volumes.reduce((s, v) => s + v.sizeGb * GB_MO, 0),
  )

  return {
    eips,
    natGateways,
    volumes,
    idleInstances: idleInstances.filter(kept),
    idleDatabases: idleDatabases.filter(kept),
    estMonthlyUsd,
  }
}
