import {
  EC2Client,
  DescribeAddressesCommand,
  DescribeNatGatewaysCommand,
  DescribeVolumesCommand,
} from '@aws-sdk/client-ec2'
import { clientOpts } from './runtime/awsClient.js'

// #10 — Sprechi: risorse a costo che spesso restano orfane. Read-only (EC2 Describe).
// Stime mensili APPROSSIMATIVE (USD, eu-central-1) solo per dare un ordine di grandezza.
const EIP_MO = 3.6 // Elastic IP non associato (~$0.005/h)
const NAT_MO = 32 // NAT Gateway (~$0.045/h, banda esclusa)
const GB_MO = 0.08 // EBS gp3 ~$0.08/GB/mese

export async function findWaste({ profile, roleArn, externalId, region }) {
  const ec2 = new EC2Client(clientOpts({ profile, roleArn, externalId, region }))

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

  const [addrs, nats, vols] = await Promise.all([
    ec2.send(new DescribeAddressesCommand({})).catch(() => ({ Addresses: [] })),
    collectNat().catch(() => []),
    collectVol().catch(() => []),
  ])

  // EIP senza AssociationId = non agganciato a nulla → spreco netto.
  const eips = (addrs.Addresses ?? [])
    .filter((a) => !a.AssociationId)
    .map((a) => ({ id: a.AllocationId, ip: a.PublicIp }))
  const natGateways = nats.map((n) => ({ id: n.NatGatewayId, vpc: n.VpcId }))
  // Volumi in stato "available" = staccati da ogni istanza → spreco.
  const volumes = vols.map((v) => ({ id: v.VolumeId, sizeGb: v.Size ?? 0 }))

  const estMonthlyUsd = Math.round(
    eips.length * EIP_MO +
      natGateways.length * NAT_MO +
      volumes.reduce((s, v) => s + v.sizeGb * GB_MO, 0),
  )

  return { eips, natGateways, volumes, estMonthlyUsd }
}
