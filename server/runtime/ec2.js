import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeInstanceStatusCommand,
} from '@aws-sdk/client-ec2'
import { clientOpts } from './awsClient.js'

// RuntimeProvider per istanza EC2: stato + status check (system/instance).
// Permesso: ec2:DescribeInstances, ec2:DescribeInstanceStatus.
// Config: aws: { type: ec2, instanceId: i-xxxxxxxx }
export async function ec2Runtime(cfg, aws) {
  const client = new EC2Client(clientOpts(aws))

  const out = await client.send(
    new DescribeInstancesCommand({ InstanceIds: [cfg.instanceId] }),
  )
  const inst = out.Reservations?.[0]?.Instances?.[0]
  if (!inst) return { status: 'unknown', reason: 'istanza EC2 non trovata' }

  const state = inst.State?.Name // running | stopped | terminated | pending | ...
  if (state !== 'running') {
    return {
      status: state === 'stopped' || state === 'terminated' ? 'down' : 'degraded',
      summary: state,
    }
  }

  // Status check (2/2 ok = sana).
  const st = await client.send(new DescribeInstanceStatusCommand({ InstanceIds: [cfg.instanceId] }))
  const s = st.InstanceStatuses?.[0]
  const sys = s?.SystemStatus?.Status
  const ins = s?.InstanceStatus?.Status
  const ok = sys === 'ok' && ins === 'ok'
  return { status: ok ? 'up' : 'degraded', summary: `running · checks sys:${sys ?? '?'} inst:${ins ?? '?'}` }
}
