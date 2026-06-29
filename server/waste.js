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

  const [addrs, nats, vols] = await Promise.all([
    ec2.send(new DescribeAddressesCommand({})).catch(() => ({ Addresses: [] })),
    ec2
      .send(new DescribeNatGatewaysCommand({ Filter: [{ Name: 'state', Values: ['available'] }] }))
      .catch(() => ({ NatGateways: [] })),
    ec2
      .send(new DescribeVolumesCommand({ Filters: [{ Name: 'status', Values: ['available'] }] }))
      .catch(() => ({ Volumes: [] })),
  ])

  // EIP senza AssociationId = non agganciato a nulla → spreco netto.
  const eips = (addrs.Addresses ?? [])
    .filter((a) => !a.AssociationId)
    .map((a) => ({ id: a.AllocationId, ip: a.PublicIp }))
  const natGateways = (nats.NatGateways ?? []).map((n) => ({ id: n.NatGatewayId, vpc: n.VpcId }))
  // Volumi in stato "available" = staccati da ogni istanza → spreco.
  const volumes = (vols.Volumes ?? []).map((v) => ({ id: v.VolumeId, sizeGb: v.Size ?? 0 }))

  const estMonthlyUsd = Math.round(
    eips.length * EIP_MO +
      natGateways.length * NAT_MO +
      volumes.reduce((s, v) => s + v.sizeGb * GB_MO, 0),
  )

  return { eips, natGateways, volumes, estMonthlyUsd }
}
