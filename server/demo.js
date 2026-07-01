// Demo / sandbox: dataset FINTO, zero credenziali AWS. Stessa forma di getStatus & co.
// Serve a (a) provare Dadaguard senza wiring AWS, (b) registrare la GIF di lancio,
// (c) valutare la UI. Attivo con env DADAGUARD_DEMO=1 (vedi mode.js: isDemo).
// Tutto statico e read-only: nessuna chiamata di rete.

const ACC = {
  prod: { key: 'prod', label: 'Production', color: '#cf1322' },
  staging: { key: 'staging', label: 'Staging', color: '#1677ff' },
}
const SEV = { up: 0, idle: 1, disabled: 1, unknown: 1, degraded: 2, down: 3 }
const rollup = (checks) =>
  Object.values(checks).reduce((w, c) => (SEV[c.status] > SEV[w] ? c.status : w), 'up')

const pick = (L, it, en) => (L === 'en' ? en : it)

function svc(name, acc, type, region, checks, dependsOn = []) {
  return { name, links: {}, account: ACC[acc], region, type, dependsOn, overall: rollup(checks), checks }
}

// Una flotta curata che mostra TUTTI gli stati e parecchi tipi: up / degraded / down / idle,
// mismatch versione, drift, backup vecchio, allarme attivo, secret mancante, finding sicurezza,
// cert in scadenza, bucket pubblico.
export function demoStatus(lang = 'it') {
  const L = lang === 'en' ? 'en' : 'it'
  const services = [
    svc('checkout-api', 'prod', 'ecs', 'eu-west-1', {
      liveness: { key: 'liveness', status: 'up', httpStatus: 200, latencyMs: 38 },
      version: { key: 'version', status: 'up', summary: pick(L, 'sha 9f2a1c · 3g fa', 'sha 9f2a1c · 3d ago') },
      runtime: { key: 'runtime', status: 'up', summary: pick(L, '3/3 task attivi', '3/3 tasks running') },
      drift: { key: 'drift', status: 'up', summary: pick(L, 'sì', 'yes') },
      secrets: { key: 'secrets', status: 'up', summary: pick(L, '4/4 presenti', '4/4 present') },
    }, ['payments-worker', 'user-db']),

    svc('payments-worker', 'prod', 'lambda', 'eu-west-1', {
      version: { key: 'version', status: 'up', summary: pick(L, 'v3.1.0 · 1g fa', 'v3.1.0 · 1d ago') },
      runtime: { key: 'runtime', status: 'degraded', summary: pick(L, 'errori 4.2% · p95 1.8s · 6.2k inv/h', 'errors 4.2% · p95 1.8s · 6.2k inv/h') },
      alarms: { key: 'alarms', status: 'degraded', summary: pick(L, '1 allarme attivo: Errors', '1 firing alarm: Errors') },
      secrets: { key: 'secrets', status: 'up', summary: pick(L, '3/3 presenti', '3/3 present') },
    }),

    svc('image-resizer', 'prod', 'lambda', 'eu-west-1', {
      runtime: { key: 'runtime', status: 'down', summary: pick(L, 'errori in salita · 0 ok nell’ultima ora', 'errors spiking · 0 ok in the last hour') },
      alarms: { key: 'alarms', status: 'down', summary: pick(L, '2 allarmi attivi', '2 firing alarms') },
    }),

    svc('nightly-report', 'staging', 'lambda', 'eu-west-1', {
      runtime: { key: 'runtime', status: 'disabled', summary: pick(L, 'schedule EventBridge OFF', 'EventBridge schedule OFF') },
    }),

    svc('user-db', 'prod', 'rds', 'eu-west-1', {
      runtime: { key: 'runtime', status: 'up', summary: pick(L, 'cluster available · 2/2 istanze', 'cluster available · 2/2 instances') },
      backups: { key: 'backups', status: 'degraded', summary: pick(L, 'ultimo snapshot 3g fa (soglia 2g)', 'last snapshot 3d ago (threshold 2d)') },
      drift: { key: 'drift', status: 'up', summary: pick(L, 'sì', 'yes') },
    }),

    svc('web', 'prod', 'ecs', 'eu-west-1', {
      liveness: { key: 'liveness', status: 'up', httpStatus: 200, latencyMs: 61 },
      version: { key: 'version', status: 'degraded', summary: pick(L, 'gira v1.9.0 · atteso v2.0.0', 'running v1.9.0 · expected v2.0.0') },
      runtime: { key: 'runtime', status: 'up', summary: pick(L, '2/2 task attivi', '2/2 tasks running') },
      drift: { key: 'drift', status: 'degraded', summary: pick(L, 'no · memory 512 (TF: 1024)', 'no · memory 512 (TF: 1024)') },
    }, ['user-db']),

    svc('legacy-api', 'staging', 'ec2', 'eu-west-1', {
      runtime: { key: 'runtime', status: 'up', summary: pick(L, 'running · 2/2 status check', 'running · 2/2 status checks') },
      security: { key: 'security', status: 'degraded', summary: pick(L, 'SG aperto a 0.0.0.0/0 sulla 22 (SSH)', 'SG open to 0.0.0.0/0 on 22 (SSH)') },
    }),

    svc('notifier', 'staging', 'lambda', 'eu-west-1', {
      runtime: { key: 'runtime', status: 'up', summary: pick(L, '120 inv/h · errori 0%', '120 inv/h · errors 0%') },
      secrets: { key: 'secrets', status: 'down', summary: pick(L, '1 secret mancante: SENDGRID_KEY', '1 missing secret: SENDGRID_KEY') },
    }),

    svc('public-assets', 'prod', 's3', 'eu-west-1', {
      runtime: { key: 'runtime', status: 'degraded', summary: pick(L, 'bucket ESPOSTO pubblicamente', 'bucket PUBLICLY exposed') },
    }),

    svc('cdn-cert', 'prod', 'acm', 'us-east-1', {
      runtime: { key: 'runtime', status: 'degraded', summary: pick(L, 'scade tra 12 giorni (2026-07-12)', 'expires in 12 days (2026-07-12)') },
    }),

    svc('sessions', 'staging', 'elasticache', 'eu-west-1', {
      runtime: { key: 'runtime', status: 'up', summary: pick(L, 'available · 1 nodo', 'available · 1 node') },
    }),

    svc('events-stream', 'prod', 'kinesis', 'eu-west-1', {
      runtime: { key: 'runtime', status: 'up', summary: pick(L, 'ACTIVE · 4 shard', 'ACTIVE · 4 shards') },
    }),

    svc('public-lb', 'prod', 'alb', 'eu-west-1', {
      runtime: { key: 'runtime', status: 'up', summary: pick(L, '2 target group · 5/5 sani', '2 target groups · 5/5 healthy') },
      drift: { key: 'drift', status: 'up', summary: pick(L, 'sì', 'yes') },
    }),

    svc('order-flow', 'prod', 'sfn', 'eu-west-1', {
      runtime: { key: 'runtime', status: 'up', summary: pick(L, '12 esecuzioni · 0 fallite (24h)', '12 executions · 0 failed (24h)') },
    }),
  ]

  return {
    generatedAt: new Date().toISOString(),
    mode: 'demo',
    capabilities: { watchlist: false, discover: false, fullDrift: false },
    discovered: null,
    services,
  }
}

// Drawer (read-only, dati finti coerenti con la flotta sopra).
export function demoCosts() {
  return {
    prod: {
      label: 'Production', color: '#cf1322',
      items: [
        { service: 'Amazon Elastic Container Service', amount: 142.3 },
        { service: 'Amazon RDS', amount: 88.0 },
        { service: 'AWS Lambda', amount: 12.4 },
        { service: 'Amazon CloudFront', amount: 9.1 },
      ],
      gross: 251.8, credits: -40, total: 211.8, net: 211.8,
      period: { start: '2026-06-01', end: '2026-06-30' }, currency: 'USD',
    },
    staging: {
      label: 'Staging', color: '#1677ff',
      items: [
        { service: 'Amazon Elastic Container Service', amount: 33.2 },
        { service: 'Amazon ElastiCache', amount: 18.0 },
      ],
      gross: 51.2, credits: 0, total: 51.2, net: 51.2,
      period: { start: '2026-06-01', end: '2026-06-30' }, currency: 'USD',
    },
  }
}

export function demoQuotas() {
  return {
    accounts: [
      {
        account: 'prod', label: 'Production', color: '#cf1322',
        quotas: [
          { name: 'Lambda · Concurrent executions', used: 842, limit: 1000, pct: 84 },
          { name: 'VPC · Elastic IP addresses', used: 4, limit: 5, pct: 80 },
        ],
      },
    ],
  }
}

// Topologia dipendenze finta, coerente coi servizi della flotta demo: mostra tutte le provenienze
// d'arco (env/event/net/flow/declared) e alcune dipendenze degradate (arco rosso), più una coda
// esterna non tracciata (extraNode). Serve a far vedere la feature senza una connessione AWS.
export function demoTopology() {
  return {
    edges: [
      { source: 'checkout-api', target: 'payments-worker', vias: ['env'] }, // target degradato → rosso
      { source: 'checkout-api', target: 'user-db', vias: ['net'] }, // target degradato → rosso
      { source: 'checkout-api', target: 'sessions', vias: ['net'] }, // net su target sano → teal
      { source: 'payments-worker', target: 'user-db', vias: ['env'] }, // rosso
      { source: 'payments-worker', target: 'events-stream', vias: ['event'] }, // event → viola
      { source: 'web', target: 'user-db', vias: ['net'] }, // rosso
      { source: 'web', target: 'sessions', vias: ['env'] }, // env su target sano → blu
      { source: 'image-resizer', target: 'public-assets', vias: ['env'] }, // rosso
      { source: 'legacy-api', target: 'sessions', vias: ['declared'] }, // declared → grigio
      { source: 'notifier', target: 'ext:sqs:email-queue', vias: ['event'] }, // coda esterna
      { source: 'public-lb', target: 'checkout-api', vias: ['lb'] }, // lb su target sano → arancione
      { source: 'public-lb', target: 'web', vias: ['lb'] }, // target degradato → rosso
      { source: 'order-flow', target: 'checkout-api', vias: ['flow'] }, // flow su target sano → rosa
      { source: 'order-flow', target: 'payments-worker', vias: ['flow'] }, // rosso
    ],
    extraNodes: [{ id: 'ext:sqs:email-queue', type: 'sqs', label: 'email-queue' }],
  }
}

export function demoLogs() {
  const now = Date.now()
  return {
    logGroup: '/aws/lambda/payments-worker',
    truncated: false,
    events: [
      { ts: now - 9000, message: JSON.stringify({ level: 'info', msg: 'charge captured', id: 'ch_8812', amount: 49.0 }) },
      { ts: now - 6000, message: JSON.stringify({ level: 'warn', msg: 'gateway slow, retrying', attempt: 2 }) },
      { ts: now - 3000, message: JSON.stringify({ level: 'error', msg: 'card declined', code: 'do_not_honor' }) },
    ],
  }
}

export function demoSelfcheck() {
  return {
    status: 'up', allOk: true, anyFail: false,
    accounts: [
      { key: 'prod', label: 'Production', color: '#cf1322', ok: true, account: '111122223333', arn: 'arn:aws:sts::111122223333:assumed-role/dadaguard-readonly/dadaguard', via: 'roleArn' },
      { key: 'staging', label: 'Staging', color: '#1677ff', ok: true, account: '444455556666', arn: 'arn:aws:sts::444455556666:assumed-role/dadaguard-readonly/dadaguard', via: 'roleArn' },
    ],
  }
}

export function demoEvents() {
  const now = Date.now()
  return {
    events: [
      { ts: now - 180000, message: '(service web) has started 1 tasks' },
      { ts: now - 120000, message: '(service web) deployment ECS-svc completed' },
      { ts: now - 60000, message: '(service web) has reached a steady state' },
    ],
    changes: [
      { ts: now - 130000, eventName: 'UpdateService', user: 'github-actions', source: 'ecs.amazonaws.com', errorCode: null },
      { ts: now - 900000, eventName: 'RegisterTaskDefinition', user: 'github-actions', source: 'ecs.amazonaws.com', errorCode: null },
      { ts: now - 3600000, eventName: 'PutScalingPolicy', user: 'matteo', source: 'application-autoscaling.amazonaws.com', errorCode: 'AccessDenied' },
    ],
  }
}
