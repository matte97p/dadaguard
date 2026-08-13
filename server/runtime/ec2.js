import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeInstanceStatusCommand,
} from '@aws-sdk/client-ec2'
import { clientOpts } from './awsClient.js'

// RuntimeProvider per istanza EC2: stato + status check (system/instance).
// Permesso: ec2:DescribeInstances, ec2:DescribeInstanceStatus.
// Config: aws: { type: ec2, instanceId: i-xxxxxxxx }
export async function ec2Runtime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const client = new EC2Client(clientOpts(aws))

  const out = await client.send(
    new DescribeInstancesCommand({ InstanceIds: [cfg.instanceId] }),
  )
  const inst = out.Reservations?.[0]?.Instances?.[0]
  if (!inst) return { status: 'unknown', reason: t('ec2.notfound') }

  const state = inst.State?.Name // running | stopped | terminated | pending | ...
  const stKey = `ec2.state.${state}`
  const stLabel = t(stKey) === stKey ? state : t(stKey)
  if (state !== 'running') {
    return {
      status: state === 'stopped' || state === 'terminated' ? 'down' : 'degraded',
      summary: stLabel,
    }
  }

  // Status check AWS (2/2 ok = sana): controllo sistema + controllo istanza.
  const st = await client.send(new DescribeInstanceStatusCommand({ InstanceIds: [cfg.instanceId] }))
  const s = st.InstanceStatuses?.[0]
  const sys = s?.SystemStatus?.Status
  const ins = s?.InstanceStatus?.Status
  const okCount = (sys === 'ok' ? 1 : 0) + (ins === 'ok' ? 1 : 0)
  const ok = okCount === 2
  // "check AWS 1/2 ok" non dice quale: il controllo di SISTEMA è l'host sotto (lo aggiusta AWS, o si
  // sposta l'istanza), quello dell'ISTANZA è il sistema operativo dentro (lo aggiustiamo noi). Sono due
  // guasti con due destinatari diversi. Se AWS non ha ancora pubblicato i controlli, si dice anche quello.
  const fuori = [sys !== 'ok' ? t('ec2.check.system') : null, ins !== 'ok' ? t('ec2.check.instance') : null].filter(Boolean)
  const alert = ok ? undefined : !s ? t('ec2.nochecks') : t('ec2.alert', { list: fuori.join(' e '), n: fuori.length })
  return { status: ok ? 'up' : 'degraded', summary: t('ec2.checks', { ok: okCount }), ...(alert ? { alert } : {}) }
}

// #2 build/deploy zero-config per EC2: AMI + da quando è su (LaunchTime).
// Permesso: ec2:DescribeInstances (già concesso). Ritorna { ami, launchTime } o null.
export async function ec2BuildInfo(cfg, aws) {
  const client = new EC2Client(clientOpts(aws))
  const out = await client.send(new DescribeInstancesCommand({ InstanceIds: [cfg.instanceId] }))
  const inst = out.Reservations?.[0]?.Instances?.[0]
  if (!inst) return null
  return { ami: inst.ImageId ?? null, launchTime: inst.LaunchTime ?? null }
}
