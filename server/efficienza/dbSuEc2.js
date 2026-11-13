import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DescribeTargetGroupsCommand, DescribeTargetHealthCommand } from '@aws-sdk/client-elastic-load-balancing-v2'
import { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand } from '@aws-sdk/client-ec2'
import { clientOpts } from '../runtime/awsClient.js'
import { prezzoEc2, prezzoEbs } from './prezzi.js'
import { ORE_MESE } from './regole.js'

// Un Postgres che non è su RDS (su EC2, dietro un load balancer): quanto costa e su quante copie gira.
// Si risale dal NOME a cui Dadaguard si collega, senza configurare niente: host del load balancer →
// target group → istanze registrate → i loro volumi EBS. Ogni nodo ha la sua copia dei dati, quindi
// uno spreco di disco (indici mai usati, righe morte) si paga una volta per nodo.
//
// Permessi: elasticloadbalancing:DescribeLoadBalancers, DescribeTargetGroups, DescribeTargetHealth,
// ec2:DescribeInstances, ec2:DescribeVolumes, pricing:GetProducts. Tutti già nella policy read-only.

// Il nome di un load balancer AWS (`<nome>-<id>.elb.<regione>.amazonaws.com`): solo da lì si risale ai
// nodi. Un host qualunque (un IP, un DNS nostro) resta senza costo. Puro.
export function eHostElb(host) {
  return /\.elb\.[a-z0-9-]+\.amazonaws\.com$/i.test(String(host ?? ''))
}

// Il conto, dai nodi e dai volumi già letti. Puro: testabile senza AWS.
//   nodi    = [{ id, tipo, volumi: [volumeId] }]
//   volumi  = { volumeId: { gb, tipo } }
//   prezzi  = { istanza: { tipo: usdOra }, disco: { tipoVolume: usdGbMese } }
export function contoDb({ nodi, volumi, prezzi }) {
  if (!nodi?.length) return null
  let usdMese = 0
  let ignoto = false
  let discoGb = 0
  const tipiDisco = new Map()
  for (const n of nodi) {
    const ora = prezzi?.istanza?.[n.tipo]
    if (ora == null) ignoto = true
    else usdMese += ora * ORE_MESE
    for (const v of n.volumi ?? []) {
      const vol = volumi?.[v]
      if (!vol) continue
      const gbMese = prezzi?.disco?.[vol.tipo]
      if (gbMese == null) ignoto = true
      else usdMese += vol.gb * gbMese
      discoGb += vol.gb
      tipiDisco.set(vol.tipo, (tipiDisco.get(vol.tipo) ?? 0) + vol.gb)
    }
  }
  // Il disco dei dati è il tipo con più GB: è quello dove stanno tabelle e indici.
  const principale = [...tipiDisco.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const tipi = [...new Set(nodi.map((n) => n.tipo))]
  return {
    repliche: nodi.length,
    classe: tipi.join(', '),
    discoGb,
    tipoDisco: principale,
    discoGbMese: principale ? prezzi?.disco?.[principale] ?? null : null,
    usdMese: ignoto ? null : usdMese,
  }
}

export async function infraDbSuEc2(aws, host) {
  if (!eHostElb(host)) return null
  const elb = new ElasticLoadBalancingV2Client(clientOpts(aws))
  let lb = null
  let Marker
  let pagine = 0
  do {
    const r = await elb.send(new DescribeLoadBalancersCommand({ Marker }))
    lb = (r.LoadBalancers ?? []).find((l) => String(l.DNSName).toLowerCase() === String(host).toLowerCase()) ?? null
    Marker = lb ? null : r.NextMarker
  } while (Marker && ++pagine < 20)
  if (!lb) return null

  const tgs = (await elb.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: lb.LoadBalancerArn }))).TargetGroups ?? []
  const ids = new Set()
  for (const tg of tgs.filter((t) => t.TargetType === 'instance')) {
    const h = await elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }))
    for (const d of h.TargetHealthDescriptions ?? []) if (d.Target?.Id) ids.add(d.Target.Id)
  }
  if (!ids.size) return null

  const ec2 = new EC2Client(clientOpts(aws))
  const ri = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [...ids] }))
  const nodi = (ri.Reservations ?? []).flatMap((r) => r.Instances ?? []).map((i) => ({
    id: i.InstanceId,
    tipo: i.InstanceType,
    volumi: (i.BlockDeviceMappings ?? []).map((b) => b.Ebs?.VolumeId).filter(Boolean),
  }))
  const idVolumi = nodi.flatMap((n) => n.volumi)
  const rv = idVolumi.length ? await ec2.send(new DescribeVolumesCommand({ VolumeIds: idVolumi })) : { Volumes: [] }
  const volumi = Object.fromEntries((rv.Volumes ?? []).map((v) => [v.VolumeId, { gb: v.Size ?? 0, tipo: v.VolumeType }]))

  const prezzi = { istanza: {}, disco: {} }
  await Promise.all([
    ...[...new Set(nodi.map((n) => n.tipo))].map(async (t) => {
      prezzi.istanza[t] = await prezzoEc2(aws, { region: aws.region, tipo: t }).catch(() => null)
    }),
    ...[...new Set(Object.values(volumi).map((v) => v.tipo))].map(async (t) => {
      prezzi.disco[t] = await prezzoEbs(aws, { region: aws.region, tipo: t }).catch(() => null)
    }),
  ])
  return contoDb({ nodi, volumi, prezzi })
}
