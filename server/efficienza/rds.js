import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds'
import { EC2Client, DescribeInstanceTypesCommand } from '@aws-sdk/client-ec2'
import { clientOpts } from '../runtime/awsClient.js'
import { cached } from '../util/ttlcache.js'
import { serieOrarie } from './serie.js'
import { prezzoRds, prezzoDiscoRds } from './prezzi.js'
import { classeSotto, dbReggeTagliaSotto, percentile, ORE_MESE } from './regole.js'

// Database: ogni istanza RDS e Aurora dell'account con la sua classe, quanto costa a listino e quanto
// la usa davvero (CPU al picco, memoria libera minima, connessioni), da CloudWatch. Non entra nel
// database: per quello c'è `pgStat.js`, opzionale.
//
// Permessi: rds:DescribeDBInstances, ec2:DescribeInstanceTypes (memoria di una classe), cloudwatch:
// GetMetricData, pricing:GetProducts.

const GIORNO = 24 * 60 * 60 * 1000
const GIORNI = 14

// Memoria di una classe RDS dalla gemella EC2 (`db.r6g.xlarge` → `r6g.xlarge`): AWS non la pubblica
// nell'API di RDS. Una classe senza gemella resta senza memoria, e la regola della taglia non si applica.
function memoriaClasse(aws, classe) {
  const tipo = String(classe ?? '').replace(/^db\./, '')
  return cached(`eff:mem:${aws.region}:${tipo}`, GIORNO, async () => {
    try {
      const r = await new EC2Client(clientOpts(aws)).send(new DescribeInstanceTypesCommand({ InstanceTypes: [tipo] }))
      const t = r.InstanceTypes?.[0]
      return t ? { vcpu: t.VCpuInfo?.DefaultVCpus ?? null, memGb: (t.MemoryInfo?.SizeInMiB ?? 0) / 1024 || null } : null
    } catch {
      return null
    }
  })
}

export async function databaseAccount(aws, { tagSquadra }) {
  const rds = new RDSClient(clientOpts(aws))
  const istanze = []
  let Marker
  let pagine = 0
  do {
    const r = await rds.send(new DescribeDBInstancesCommand({ Marker }))
    istanze.push(...(r.DBInstances ?? []))
    Marker = r.Marker
  } while (Marker && ++pagine < 20)
  const vive = istanze.filter((d) => d.DBInstanceStatus === 'available' && d.DBInstanceClass !== 'db.serverless')

  const query = vive.flatMap((d, i) => {
    const dim = { DBInstanceIdentifier: d.DBInstanceIdentifier }
    return [
      { id: `c${i}`, namespace: 'AWS/RDS', metrica: 'CPUUtilization', dimensioni: dim, stat: 'p95' },
      { id: `m${i}`, namespace: 'AWS/RDS', metrica: 'FreeableMemory', dimensioni: dim, stat: 'Minimum' },
      { id: `k${i}`, namespace: 'AWS/RDS', metrica: 'DatabaseConnections', dimensioni: dim, stat: 'Maximum' },
    ]
  })
  const serie = await serieOrarie(aws, query, GIORNI)

  return Promise.all(
    vive.map(async (d, i) => {
      const valori = (k) => serie[`${k}${i}`].map(([, v]) => v)
      const spec = await memoriaClasse(aws, d.DBInstanceClass)
      const memLiberaMinGb = valori('m').length ? Math.min(...valori('m')) / 1024 ** 3 : null
      const memLiberaMin = spec?.memGb && memLiberaMinGb != null ? (memLiberaMinGb / spec.memGb) * 100 : null
      const cpuP95 = percentile(valori('c'), 0.95)
      const motore = d.Engine
      const base = { region: aws.region, motore, multiAz: Boolean(d.MultiAZ) }
      const ora = await prezzoRds(aws, { ...base, classe: d.DBInstanceClass }).catch(() => null)
      const sotto = classeSotto(d.DBInstanceClass)
      const regge = sotto && dbReggeTagliaSotto({ cpuP95, memLiberaMin })
      const oraSotto = regge ? await prezzoRds(aws, { ...base, classe: sotto }).catch(() => null) : null
      const discoGbMese = await prezzoDiscoRds(aws, { ...base, tipoDisco: d.StorageType }).catch(() => null)
      return {
        id: d.DBInstanceIdentifier,
        cluster: d.DBClusterIdentifier ?? null,
        motore,
        versione: d.EngineVersion ?? null,
        classe: d.DBInstanceClass,
        vcpu: spec?.vcpu ?? null,
        memGb: spec?.memGb ?? null,
        multiAz: Boolean(d.MultiAZ),
        replica: Boolean(d.ReadReplicaSourceDBInstanceIdentifier || d.ReadReplicaSourceDBClusterIdentifier),
        discoGb: d.AllocatedStorage ?? null,
        tipoDisco: d.StorageType ?? null,
        discoGbMese,
        squadra: (d.TagList ?? []).find((t) => t.Key === tagSquadra)?.Value ?? null,
        cpuP95,
        memLiberaMin,
        connessioniMax: valori('k').length ? Math.max(...valori('k')) : null,
        connessioniLimite: null, // dipende dal parameter group: si legge da pg_stat se acceso
        usdMese: ora != null ? ora * ORE_MESE : null,
        proposta: regge && oraSotto != null && ora != null ? { classe: sotto, usdMese: oraSotto * ORE_MESE, risparmio: (ora - oraSotto) * ORE_MESE } : null,
      }
    }),
  )
}
