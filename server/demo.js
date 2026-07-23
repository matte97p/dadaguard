// Demo / sandbox: dataset FINTO, zero credenziali AWS. Stessa forma di getStatus & co.
// Serve a (a) provare Dadaguard senza wiring AWS, (b) registrare la GIF di lancio,
// (c) valutare la UI. Attivo con env DADAGUARD_DEMO=1 (vedi mode.js: isDemo).
// Tutto statico e read-only: nessuna chiamata di rete.
import { monthEndProjection } from './costs.js'
import { computeOverall } from './status.js'

const ACC = {
  prod: { key: 'prod', label: 'Production', color: '#cf1322' },
  staging: { key: 'staging', label: 'Staging', color: '#1677ff' },
}

const pick = (L, it, en) => (L === 'en' ? en : it)

// Stessa forma della card reale: overall + cause/causes (badge parlante) dallo stesso computeOverall.
function svc(name, acc, type, region, checks, dependsOn = []) {
  return { name, links: {}, account: ACC[acc], region, type, dependsOn, ...computeOverall(checks), checks }
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

    // Cron su ECS RunTask (EventBridge Scheduler → RunTask): dead-man switch via log group del task.
    svc('nightly-bi-refresh', 'prod', 'ecs-scheduled', 'eu-west-1', {
      runtime: {
        key: 'runtime',
        status: 'up',
        summary: pick(L, 'gira come da schedule (ogni 1g)', 'running on schedule (every 1d)'),
        schedule: '1440m',
        scheduleExpr: 'cron(0 1 * * ? *)',
      },
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
// Deploy demo: uno in corso + storici (ok/fallito), per account. Tempi relativi a "ora" così la
// demo mostra sempre deploy freschi. Timestamp ISO (come li serializza l'API reale su HTTP).
export function demoDeploys() {
  const m = 60_000
  const now = Date.now()
  const iso = (ms) => new Date(now - ms).toISOString()
  const FAILED = new Set(['FAILED', 'FAULT', 'TIMED_OUT'])
  // Fasi demo per stato: ok → tutte riuscite; fallito → BUILD fallita col messaggio; in corso → BUILD in corso.
  const phasesFor = (status) => {
    const ok = (type, s = 20) => ({ type, status: 'SUCCEEDED', durationMs: s * 1000 })
    const head = [ok('SUBMITTED', 1), ok('QUEUED', 2), ok('PROVISIONING', 25), ok('DOWNLOAD_SOURCE', 8), ok('INSTALL', 30), ok('PRE_BUILD', 12)]
    if (status === 'IN_PROGRESS') return [...head, { type: 'BUILD', status: 'IN_PROGRESS', durationMs: null }]
    if (FAILED.has(status))
      return [
        ...head,
        { type: 'BUILD', status: 'FAILED', durationMs: 47 * 1000, message: 'COMMAND_EXECUTION_ERROR: Error while executing command: `pnpm build`. Reason: exit status 1' },
        { type: 'COMPLETED', status: null, durationMs: null },
      ]
    return [...head, ok('BUILD', 95), ok('POST_BUILD', 18), ok('UPLOAD_ARTIFACTS', 6), { type: 'COMPLETED', status: null, durationMs: null }]
  }
  const b = (service, env, number, status, agoMin, commit, trigger = 'auto', durMin = 3) => {
    const phases = phasesFor(status)
    const fail = FAILED.has(status) ? phases.find((p) => p.status === 'FAILED') : null
    return {
      id: `cato-${env}-${service}-deploy:demo-${number}`,
      service,
      project: `cato-${env}-${service}-deploy`,
      number,
      status,
      inProgress: status === 'IN_PROGRESS',
      commit,
      trigger,
      phase: status === 'IN_PROGRESS' ? 'BUILD' : 'COMPLETED',
      startedAt: iso(agoMin * m),
      endedAt: status === 'IN_PROGRESS' ? null : iso((agoMin - durMin) * m),
      durationMs: status === 'IN_PROGRESS' ? null : durMin * m,
      phases,
      failPhase: fail ? fail.type : null,
      failReason: fail ? fail.message : null,
      logsUrl: 'https://console.aws.amazon.com/cloudwatch/home#logsV2:log-groups/log-group/$252Faws$252Fcodebuild$252Fdemo',
    }
  }
  return {
    staging: {
      label: 'Staging',
      color: '#1677ff',
      builds: [
        b('backend', 'staging', 42, 'IN_PROGRESS', 2, 'b4f9558'),
        b('backend', 'staging', 41, 'SUCCEEDED', 55, '5742eae'),
        b('backend', 'staging', 40, 'SUCCEEDED', 130, '3064fdb'),
        b('backend', 'staging', 39, 'FAILED', 210, 'f7de76e'),
        b('backend', 'staging', 38, 'SUCCEEDED', 280, 'e866622'),
        b('agentic-chat', 'staging', 18, 'FAILED', 26, '3e1c9a0'),
        b('agentic-chat', 'staging', 17, 'FAILED', 95, '2b1c0d4', 'auto', 1),
        b('garanzia', 'staging', 7, 'SUCCEEDED', 180, 'a90f231', 'manuale', 2),
      ],
    },
    prod: {
      label: 'Production',
      color: '#cf1322',
      builds: [b('backend', 'production', 55, 'SUCCEEDED', 300, '7d4b8e1', 'manuale', 5)],
    },
    management: { label: 'Management (payer)', color: '#722ed1', builds: [], noProjects: true },
    security: { label: 'Security', color: '#13c2c2', builds: [], noProjects: true },
  }
}

export function demoCosts() {
  // Snapshot "mese corrente a metà" (MTD ~12/31 gg): la proiezione di fine mese è calcolata con la
  // stessa funzione pura del percorso reale, così la demo mostra davvero la feature (run-rate).
  const withProjection = (acc) => ({ ...acc, projection: monthEndProjection(acc) })
  return {
    prod: withProjection({
      label: 'Production', color: '#cf1322',
      items: [
        { service: 'Amazon Elastic Container Service', amount: 142.3 },
        { service: 'Amazon RDS', amount: 88.0 },
        { service: 'AWS Lambda', amount: 12.4 },
        { service: 'Amazon CloudFront', amount: 9.1 },
      ],
      gross: 251.8, credits: -40, total: 211.8, net: 211.8,
      period: { start: '2026-07-01', end: '2026-07-13' }, currency: 'USD',
    }),
    staging: withProjection({
      label: 'Staging', color: '#1677ff',
      items: [
        { service: 'Amazon Elastic Container Service', amount: 33.2 },
        { service: 'Amazon ElastiCache', amount: 18.0 },
      ],
      gross: 51.2, credits: 0, total: 51.2, net: 51.2,
      period: { start: '2026-07-01', end: '2026-07-13' }, currency: 'USD',
    }),
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

export function demoFreeTier() {
  return {
    items: [
      { service: 'AWS CodeBuild', usageType: 'Build-Min:Linux:g1.small', region: null, unit: 'Minutes', used: 131, limit: 100, forecast: 190, pct: 131 },
      { service: 'Amazon DynamoDB', usageType: 'Storage-ByteHrs', region: null, unit: 'GB-Mo', used: 21, limit: 25, forecast: 24, pct: 84 },
      { service: 'AWS Lambda', usageType: 'Global-Request', region: null, unit: 'Requests', used: 210000, limit: 1000000, forecast: 480000, pct: 21 },
      { service: 'Amazon S3', usageType: 'Requests-Tier1', region: null, unit: 'Requests', used: 400, limit: 2000, forecast: 900, pct: 20 },
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
      { source: 'nightly-report', target: 'events-stream', vias: ['iam'] }, // iam su target sano → teal scuro
    ],
    extraNodes: [{ id: 'ext:sqs:email-queue', type: 'sqs', label: 'email-queue' }],
  }
}

// IAM policy explorer finto: poche policy customer-managed con entità e permessi coerenti.
export function demoIamPolicies() {
  return {
    accounts: [
      {
        account: 'prod',
        label: 'Production',
        color: '#cf1322',
        policies: [
          { arn: 'arn:aws:iam::111122223333:policy/legacy-admin', name: 'legacy-admin', attachments: 3 },
          { arn: 'arn:aws:iam::111122223333:policy/read-only-audit', name: 'read-only-audit', attachments: 6 },
          { arn: 'arn:aws:iam::111122223333:policy/payments-db-access', name: 'payments-db-access', attachments: 2 },
          { arn: 'arn:aws:iam::111122223333:policy/checkout-runtime', name: 'checkout-runtime', attachments: 1 },
        ],
      },
      {
        account: 'staging',
        label: 'Staging',
        color: '#1677ff',
        policies: [{ arn: 'arn:aws:iam::444455556666:policy/webhook-runtime', name: 'webhook-runtime', attachments: 1 }],
      },
    ],
  }
}

export function demoIamPolicy(arn) {
  const byArn = {
    'arn:aws:iam::111122223333:policy/legacy-admin': {
      name: 'legacy-admin',
      description: 'Policy legacy troppo ampia (da restringere)',
      attachments: 3,
      statements: [{ actions: ['*'], resources: ['*'] }],
      entities: { roles: ['legacy-ops'], users: ['admin-bot'], groups: ['platform'] },
    },
    'arn:aws:iam::111122223333:policy/payments-db-access': {
      name: 'payments-db-access',
      description: 'Accesso al cluster pagamenti e al suo secret',
      attachments: 2,
      statements: [
        { actions: ['rds-db:connect'], resources: ['arn:aws:rds-db:eu-west-1:111122223333:dbuser/user-db/app'] },
        {
          actions: ['secretsmanager:GetSecretValue'],
          resources: ['arn:aws:secretsmanager:eu-west-1:111122223333:secret:prod/user-db-*'],
        },
        { actions: ['kms:Decrypt'], resources: ['arn:aws:kms:eu-west-1:111122223333:key/*'] },
      ],
      entities: { roles: ['payments-worker-role', 'checkout-api-task'], users: [], groups: [] },
    },
    'arn:aws:iam::111122223333:policy/checkout-runtime': {
      name: 'checkout-runtime',
      description: 'Runtime di checkout-api',
      attachments: 1,
      statements: [
        {
          actions: ['sqs:SendMessage', 'sqs:GetQueueAttributes'],
          resources: ['arn:aws:sqs:eu-west-1:111122223333:events-stream'],
        },
        { actions: ['s3:GetObject', 's3:PutObject'], resources: ['arn:aws:s3:::public-assets/*'] },
      ],
      entities: { roles: ['checkout-api-task'], users: [], groups: [] },
    },
    'arn:aws:iam::111122223333:policy/read-only-audit': {
      name: 'read-only-audit',
      description: 'Sola lettura per i revisori',
      attachments: 6,
      statements: [{ actions: ['cloudwatch:Get*', 'logs:FilterLogEvents', 'ec2:Describe*'], resources: ['*'] }],
      entities: { roles: ['auditor'], users: ['revisore-esterno'], groups: ['security', 'finance'] },
    },
    'arn:aws:iam::444455556666:policy/webhook-runtime': {
      name: 'webhook-runtime',
      description: 'Runtime del webhook di staging',
      attachments: 1,
      statements: [
        {
          actions: ['lambda:InvokeFunction'],
          resources: ['arn:aws:lambda:eu-west-1:444455556666:function:cato-staging-webhook'],
        },
      ],
      entities: { roles: ['cato-staging-webhook-role'], users: [], groups: [] },
    },
  }
  return (
    byArn[arn] ?? {
      name: (arn || '').split('/').pop() || 'policy',
      description: null,
      attachments: 0,
      statements: [],
      entities: { roles: [], users: [], groups: [] },
    }
  )
}

export function demoIamAccess(needle) {
  const q = String(needle || '').toLowerCase()
  const all = [
    {
      policy: 'payments-db-access',
      arn: 'arn:aws:iam::111122223333:policy/payments-db-access',
      actions: ['rds-db:connect', 'secretsmanager:GetSecretValue'],
      entities: { roles: ['payments-worker-role', 'checkout-api-task'], users: [], groups: [] },
      on: ['user-db'],
    },
    {
      policy: 'checkout-runtime',
      arn: 'arn:aws:iam::111122223333:policy/checkout-runtime',
      actions: ['sqs:SendMessage', 'sqs:GetQueueAttributes'],
      entities: { roles: ['checkout-api-task'], users: [], groups: [] },
      on: ['events-stream'],
    },
    {
      policy: 'read-only-audit',
      arn: 'arn:aws:iam::111122223333:policy/read-only-audit',
      actions: ['cloudwatch:Get*', 'ec2:Describe*'],
      entities: { roles: ['auditor'], users: ['revisore-esterno'], groups: ['security', 'finance'] },
      on: ['user-db', 'events-stream', 'public-assets', 'web', 'checkout-api'],
    },
  ]
  const matches = all
    .filter((m) => m.on.some((k) => q.includes(k) || k.includes(q)))
    .map(({ on, ...m }) => m)
  const ssoAll = [
    {
      permissionSet: 'avvista-db-operator',
      actions: ['rds-db:connect'],
      assignments: [{ account: 'Production', type: 'group', name: 'dba', members: ['db.admin'] }],
      on: ['user-db'],
    },
    {
      // accesso via policy AWS-managed con Resource:"*" → grant ampio (compare per ogni risorsa)
      permissionSet: 'AdministratorAccess',
      actions: ['*'],
      broad: true,
      assignments: [{ account: 'Production', type: 'group', name: 'admins', members: ['matteo', 'giovanni'] }],
      on: ['user-db', 'events-stream', 'public-assets', 'web', 'checkout-api'],
    },
  ]
  const ssoMatches = ssoAll.filter((m) => m.on.some((k) => q.includes(k) || k.includes(q))).map(({ on, ...m }) => m)
  return { needle, matches, ssoMatches }
}

export function demoSsoAccess() {
  return {
    available: true,
    permissionSets: [
      {
        name: 'AdministratorAccess',
        assignments: [
          { account: 'Production', type: 'group', name: 'platform-admins', members: ['matteo.perino', 'alice.rossi'] },
          { account: 'Staging', type: 'group', name: 'platform-admins', members: ['matteo.perino', 'alice.rossi'] },
        ],
      },
      {
        name: 'BillingView',
        assignments: [{ account: 'Production', type: 'group', name: 'finance', members: ['carla.bianchi'] }],
      },
      {
        name: 'ReadOnly',
        assignments: [
          { account: 'Production', type: 'group', name: 'engineering', members: ['dev.uno', 'dev.due'] },
          { account: 'Staging', type: 'group', name: 'engineering', members: ['dev.uno', 'dev.due'] },
          { account: 'Staging', type: 'group', name: 'interns', members: [] },
          { account: 'Production', type: 'user', name: 'revisore-esterno' },
        ],
      },
    ],
  }
}

export function demoSecurity() {
  return {
    findings: [
      { category: 'public', severity: 'high', account: 'staging', accountLabel: 'Staging', resource: 'legacy-api', detail: 'security group aperto a 0.0.0.0/0 · tcp 22 (SSH)' },
      { category: 'public', severity: 'high', account: 'prod', accountLabel: 'Production', resource: 'public-assets', detail: 'bucket S3 senza Public Access Block completo', link: { view: 'resource', account: 'prod', needle: 'public-assets' } },
      { category: 'public', severity: 'info', account: 'prod', accountLabel: 'Production', resource: 'public-lb', detail: 'ALB internet-facing', link: { view: 'resource', account: 'prod', needle: 'public-lb' } },
      { category: 'expiring', severity: 'medium', account: 'prod', accountLabel: 'Production', resource: 'shop.example.com', detail: 'certificato ACM scade tra 12g' },
      { category: 'iam', severity: 'high', account: 'prod', accountLabel: 'Production', resource: 'legacy-admin', detail: 'policy con Action:"*" e Resource:"*" (admin)', link: { view: 'policy', account: 'prod', arn: 'arn:aws:iam::111122223333:policy/legacy-admin' } },
      { category: 'iam', severity: 'medium', account: 'staging', accountLabel: 'Staging', resource: 'ci-deployer', detail: 'utente IAM senza MFA' },
      { category: 'iam', severity: 'medium', account: 'prod', accountLabel: 'Production', resource: 'legacy-bot', detail: 'access key attiva da 240g (non ruotata)' },
      { category: 'secret', severity: 'medium', account: 'prod', accountLabel: 'Production', resource: 'prod/user-db', detail: 'secret non ruotato da 210g', link: { view: 'resource', account: 'prod', needle: 'prod/user-db' } },
    ],
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
    surfaces: { costs: 'allowed', waste: 'allowed', quotas: 'allowed', iam: 'allowed' },
    exposure: { key: 'exposure', status: 'up', summary: 'porta pubblica protetta da Cloudflare Access' },
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
