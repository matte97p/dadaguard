// Demo / sandbox: dataset FINTO, zero credenziali AWS. Stessa forma di getStatus & co.
// Serve a (a) provare Dadaguard senza wiring AWS, (b) registrare la GIF di lancio,
// (c) valutare la UI. Attivo con env DADAGUARD_DEMO=1 (vedi mode.js: isDemo).
// Tutto statico e read-only: nessuna chiamata di rete.
import { budgetLevel } from './budgets.js'
import { monthEndProjection } from './costs.js'
import { computeOverall } from './status.js'
import { makeT } from './i18n.js'

const ACC = {
  prod: { key: 'prod', label: 'Production', color: '#cf1322' },
  staging: { key: 'staging', label: 'Staging', color: '#1677ff' },
}

// Le date della demo si calcolano da oggi, non si scrivono a mano. Con le date fisse il selettore
// del mese diceva «agosto · corrente» mentre i costi sotto erano di luglio, le anomalie di agosto e
// il trend finiva a luglio: tre mesi diversi nella stessa schermata, e sembra un bug dell'app.
// End ESCLUSIVO come nel percorso reale. Cappato al 13 per restare lo snapshot "mese a metà" che
// serve a far vedere la proiezione, e mai oltre domani: un MTD che copre giorni futuri non esiste.
const ymd = (d) => d.toISOString().slice(0, 10)
export function demoPeriod(now = new Date()) {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const endDay = Math.min(now.getUTCDate() + 1, 13)
  return { start: ymd(new Date(Date.UTC(y, m, 1))), end: ymd(new Date(Date.UTC(y, m, endDay))) }
}
// Le 13 etichette YYYY-MM del trend, che FINISCONO col mese corrente (l'ultimo è parziale).
export function demoMonths(count = 13, now = new Date()) {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - (count - 1 - i), 1))
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  })
}
const daysAgo = (n, now = new Date()) => new Date(now.getTime() - n * 86_400_000)
const midnightDaysAgo = (n) => `${ymd(daysAgo(n))}T00:00:00Z`
const inDays = (n) => ymd(daysAgo(-n))

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
  // Worker Cloudflare (Stadio 2): stessa forma delle card AWS, account 'cloudflare', check version+runtime.
  const cfSvc = (name, checks) => ({
    name,
    links: { Cloudflare: `https://dash.cloudflare.com/demo/workers/services/view/${name}/production/deployments` },
    account: { key: 'cloudflare', label: 'Cloudflare', color: '#f6821f' },
    region: null,
    type: 'cloudflare-worker',
    dependsOn: [],
    ...computeOverall(checks),
    checks,
  })
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
      runtime: { key: 'runtime', status: 'degraded', summary: pick(L, `scade tra 12 giorni (${inDays(12)})`, `expires in 12 days (${inDays(12)})`) },
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

    cfSvc('website', {
      version: { key: 'version', status: 'up', summary: pick(L, 'a1b2c3d4 · 8m fa', 'a1b2c3d4 · 8m ago') },
      runtime: {
        key: 'runtime',
        status: 'up',
        summary: pick(L, '128k richieste · 0.3% errori · 24h · CPU p99 12ms', '128k requests · 0.3% errors · 24h · CPU p99 12ms'),
        metrics: [
          { label: pick(L, 'richieste', 'requests'), value: '128k', spark: [3, 5, 8, 12, 20, 32, 44, 52, 48, 40, 30, 22] },
          { label: pick(L, 'errori', 'errors'), value: '0.3%', tone: 'warning' },
          { label: 'CPU p99', value: '12ms' },
        ],
        window: '24h',
      },
    }),
    cfSvc('admin-frontend', {
      version: { key: 'version', status: 'up', summary: pick(L, 'c9d0e1f2 · 1g fa', 'c9d0e1f2 · 1d ago') },
      runtime: {
        key: 'runtime',
        status: 'degraded',
        summary: pick(L, '9.1k richieste · 6.4% errori · 24h · CPU p99 48ms', '9.1k requests · 6.4% errors · 24h · CPU p99 48ms'),
        metrics: [
          { label: pick(L, 'richieste', 'requests'), value: '9.1k', spark: [2, 3, 3, 4, 6, 5, 7, 9, 8, 6, 5, 4] },
          { label: pick(L, 'errori', 'errors'), value: '6.4%', tone: 'critical' },
          { label: 'CPU p99', value: '48ms' },
        ],
        window: '24h',
      },
    }),
  ]

  return {
    generatedAt: new Date().toISOString(),
    mode: 'demo',
    capabilities: { watchlist: false, discover: false, fullDrift: false },
    discovered: null,
    // `management` è di proposito SENZA servizi: è il caso del payer, che ha spesa (Bedrock,
    // CodeBuild) e nulla da monitorare. Serve a far vedere in demo che un account così compare
    // comunque nel filtro e nelle pagine per-account — prima sparivano in silenzio.
    // Un account con letture NON riuscite: è il caso che il pannello prima mostrava come "vuoto".
    discoveryProblems: [
      {
        account: 'security',
        region: 'eu-central-1',
        problems: [
          { what: 'ecs', err: 'access denied (insufficient permissions)' },
          { what: 'lambda', err: 'access denied (insufficient permissions)' },
        ],
      },
    ],
    accounts: [
      { key: 'prod', label: 'Production', color: '#cf1322', region: 'eu-west-1', queryable: true },
      { key: 'staging', label: 'Staging', color: '#1677ff', region: 'eu-west-1', queryable: true },
      { key: 'cloudflare', label: 'Cloudflare', color: '#f38020', region: null, queryable: true },
      { key: 'management', label: 'Management (payer)', color: '#722ed1', region: 'eu-central-1', queryable: true },
    ],
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
  const b = (service, env, number, status, agoMin, commit, trigger = 'auto', durMin = 3, author = 'dev@example.com') => {
    const phases = phasesFor(status)
    const fail = FAILED.has(status) ? phases.find((p) => p.status === 'FAILED') : null
    return {
      id: `demo-${env}-${service}-deploy:demo-${number}`,
      service,
      project: `demo-${env}-${service}-deploy`,
      number,
      status,
      inProgress: status === 'IN_PROGRESS',
      commit,
      trigger,
      author,
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
  // Riavvio forzato a mano (`update-service --force-new-deployment`): non è una build — nessuna
  // fase, nessuna durata, nessun commit — e infatti è quello che la pagina prima non vedeva.
  const rst = (service, cluster, agoMin, forcedBy, { status = 'SUCCEEDED', failReason = null, viaTeleport = true } = {}) => ({
    id: `restart:demo-${service}-${agoMin}`,
    kind: 'restart',
    provider: 'ecs',
    service,
    cluster,
    status,
    inProgress: false,
    trigger: 'restart',
    forcedBy,
    viaTeleport,
    startedAt: iso(agoMin * m),
    endedAt: iso(agoMin * m),
    durationMs: null,
    commit: null,
    failReason,
  })
  // Build Cloudflare Worker: status sempre SUCCEEDED, con autore, versioni (rollout) + link dashboard.
  const cfb = (service, agoMin, source, versionId, author = 'ci@example.com', versions) => ({
    id: `${service}:${versionId}`,
    service,
    project: service,
    number: null,
    status: 'SUCCEEDED',
    inProgress: false,
    commit: versionId.slice(0, 8),
    trigger: /dash/.test(source) ? 'manuale' : 'auto',
    startedAt: iso(agoMin * m),
    endedAt: iso(agoMin * m),
    durationMs: null,
    provider: 'cloudflare',
    kind: 'worker',
    author,
    versions: versions ?? [{ id: versionId, percentage: 100 }],
    deployUrl: `https://dash.cloudflare.com/demo/workers/services/view/${service}/production/deployments`,
  })
  // Build Cloudflare Pages: hanno uno STATO reale (può fallire) + branch/env.
  const cfp = (project, agoMin, status, commit, branch = 'main', author = 'sam@example.com') => ({
    id: `${project}:${commit}`,
    service: project,
    project,
    number: null,
    status,
    inProgress: false,
    commit: commit.slice(0, 8),
    trigger: 'auto',
    startedAt: iso(agoMin * m),
    endedAt: iso(agoMin * m),
    durationMs: null,
    provider: 'cloudflare',
    kind: 'pages',
    author,
    branch,
    env: 'production',
    failPhase: status === 'FAILED' ? 'build' : null,
    failReason: null,
    deployUrl: `https://dash.cloudflare.com/demo/pages/view/${project}`,
  })
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
        b('search-api', 'staging', 18, 'FAILED', 26, '3e1c9a0'),
        b('search-api', 'staging', 17, 'FAILED', 95, '2b1c0d4', 'auto', 1),
        b('billing-worker', 'staging', 7, 'SUCCEEDED', 180, 'a90f231', 'manuale', 2),
      ],
    },
    prod: {
      label: 'Production',
      color: '#cf1322',
      builds: [
        // Riavvio a mano recente: l'azione che la pagina prima non vedeva (nessuna build dietro).
        rst('backend', 'demo-production', 12, 'sam'),
        // Hotfix: build lanciata fuori dalla CI. Chi ha PREMUTO (forcedBy) non è l'autore del commit.
        { ...b('backend', 'production', 56, 'SUCCEEDED', 45, 'c1a2b3d', 'hotfix', 4, 'alex@example.com'), forcedBy: 'sam', viaTeleport: true },
        b('backend', 'production', 55, 'SUCCEEDED', 300, '7d4b8e1', 'manuale', 5),
        // Tentativo di riavvio RESPINTO: spiega perché il servizio è ancora incastrato.
        rst('billing-worker', 'demo-production', 620, 'alex', {
          status: 'FAILED',
          failReason: 'AccessDenied: not authorized to perform ecs:UpdateService',
        }),
      ],
    },
    // Nessun progetto `*-deploy` qui, ma i riavvii ci sono comunque (in management gira Dadaguard).
    management: {
      label: 'Management (payer)',
      color: '#722ed1',
      builds: [rst('dadaguard', 'demo-management', 400, 'sam@example.com', { viaTeleport: false })],
      noProjects: true,
    },
    security: { label: 'Security', color: '#13c2c2', builds: [], noProjects: true },
    // Cloudflare: Worker (rollout via Wrangler/dash, solo riusciti) + Pages (con stato reale, possono fallire).
    cloudflare: {
      label: 'Cloudflare',
      color: '#f6821f',
      provider: 'cloudflare',
      builds: [
        // Worker in rollout graduale (canary): due versioni con % di traffico
        cfb('website', 8, 'wrangler', 'a1b2c3d4e5f6', 'ci@example.com', [
          { id: 'a1b2c3d4e5f6', percentage: 90 },
          { id: 'f6e5d4c3b2a1', percentage: 10 },
        ]),
        cfb('website', 1600, 'wrangler', 'f6e5d4c3b2a1'),
        cfb('geo-edge', 320, 'wrangler', '0f1e2d3c4b5a'),
        // Pages: un deploy riuscito + uno FALLITO (le Pages, a differenza dei Worker, registrano i falliti)
        cfp('admin-frontend', 90, 'SUCCEEDED', 'c9d0e1f2a3b4', 'main'),
        cfp('marketing-site', 40, 'FAILED', 'b7a6c5d4e3f2', 'feat/new-hero'),
        cfp('marketing-site', 500, 'SUCCEEDED', '1a2b3c4d5e6f', 'main'),
      ],
    },
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
        { service: 'Amazon Bedrock', amount: 402.0, ai: true },
      ],
      gross: 653.8, credits: -40, tax: 3.2, aiGross: 402, infraGross: 251.8, total: 617.0, net: 617.0,
      period: demoPeriod(), currency: 'USD',
    }),
    management: withProjection({
      label: 'Management (payer)', color: '#722ed1',
      items: [
        { service: 'AWS Marketplace (Claude Sonnet)', amount: 118.4, ai: true },
        { service: 'CodeBuild', amount: 14.2 },
      ],
      gross: 132.6, credits: 0, tax: 0, aiGross: 118.4, infraGross: 14.2, total: 132.6, net: 132.6,
      period: demoPeriod(), currency: 'USD',
    }),
    staging: withProjection({
      label: 'Staging', color: '#1677ff',
      items: [
        { service: 'Amazon Elastic Container Service', amount: 33.2 },
        { service: 'Amazon ElastiCache', amount: 18.0 },
      ],
      gross: 51.2, credits: 0, total: 51.2, net: 51.2,
      period: demoPeriod(), currency: 'USD',
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
  // Gli estremi sono CHIAVI `account::nome`, come nel percorso reale: il nome da solo fonderebbe due
  // servizi omonimi di ambienti diversi in un nodo unico.
  const P = (n) => `prod::${n}`
  const S = (n) => `staging::${n}`
  return {
    edges: [
      { source: P('checkout-api'), target: P('payments-worker'), vias: ['env'] }, // target degradato → rosso
      { source: P('checkout-api'), target: P('user-db'), vias: ['net'] }, // target degradato → rosso
      { source: P('checkout-api'), target: S('sessions'), vias: ['net'] }, // net su target sano → teal
      { source: P('payments-worker'), target: P('user-db'), vias: ['env'] }, // rosso
      { source: P('payments-worker'), target: P('events-stream'), vias: ['event'] }, // event → viola
      { source: P('web'), target: P('user-db'), vias: ['net'] }, // rosso
      { source: P('web'), target: S('sessions'), vias: ['env'] }, // env su target sano → blu
      { source: P('image-resizer'), target: P('public-assets'), vias: ['env'] }, // rosso
      { source: S('legacy-api'), target: S('sessions'), vias: ['declared'] }, // declared → grigio
      { source: S('notifier'), target: 'ext:sqs:email-queue', vias: ['event'] }, // coda esterna
      { source: P('public-lb'), target: P('checkout-api'), vias: ['lb'] }, // lb su target sano → arancione
      { source: P('public-lb'), target: P('web'), vias: ['lb'] }, // target degradato → rosso
      { source: P('order-flow'), target: P('checkout-api'), vias: ['flow'] }, // flow su target sano → rosa
      { source: P('order-flow'), target: P('payments-worker'), vias: ['flow'] }, // rosso
      { source: S('nightly-report'), target: P('events-stream'), vias: ['iam'] }, // iam su target sano → teal scuro
      // Sistemi FUORI da AWS, riconosciuti dagli hostname nella configurazione: in uno stack vero è qui
      // che finisce metà dei dati, e una topologia che li tace risponde «niente» alla prima domanda.
      { source: P('checkout-api'), target: 'ext:host:analytics-suite.com', vias: ['env'] },
      { source: P('web'), target: 'ext:host:analytics-suite.com', vias: ['env'] },
      { source: S('notifier'), target: 'ext:host:mail-provider.io', vias: ['env'] },
    ],
    extraNodes: [
      { id: 'ext:sqs:email-queue', type: 'sqs', label: 'email-queue' },
      { id: 'ext:host:analytics-suite.com', type: 'esterno', label: 'analytics-suite.com', hosts: ['eu.analytics-suite.com'] },
      { id: 'ext:host:mail-provider.io', type: 'esterno', label: 'mail-provider.io', hosts: ['api.mail-provider.io'] },
    ],
    // Come nel percorso reale: la flotta INTERA, non solo i nodi con archi. Serve alla UI per tenere
    // disegnati i vicini che un filtro esclude, invece di svuotare il grafo.
    nodes: demoStatus('en').services.map((s) => ({
      id: `${s.account?.key ?? '__none__'}::${s.name}`,
      name: s.name,
      account: s.account?.key ?? null,
      type: s.type ?? null,
    })),
  }
}

// Rete finta: due VPC per account, subnet pubbliche e private con la loro zona, e il gruppo «senza VPC»
// per le lambda che non ci stanno dentro. In demo la vista di rete rispondeva «niente da mostrare», che
// per l'immagine pubblica del progetto è una pagina vuota su una feature che esiste.
export function demoNetwork() {
  const risorse = (nomi) => nomi.map(([name, type]) => ({ name, type }))
  return {
    accounts: [
      {
        account: 'prod',
        label: 'Production',
        color: '#722ed1',
        vpcs: [
          {
            id: 'vpc-0aa1',
            name: 'prod-vpc',
            cidr: '10.20.0.0/16',
            nat: 2,
            igw: true,
            subnets: [
              { id: 'subnet-1a', name: 'public-a', az: 'eu-central-1a', public: true, services: risorse([['public-lb', 'alb'], ['web', 'ecs']]) },
              { id: 'subnet-1b', name: 'private-a', az: 'eu-central-1a', public: false, services: risorse([['checkout-api', 'ecs'], ['payments-worker', 'lambda']]) },
              { id: 'subnet-1c', name: 'private-b', az: 'eu-central-1b', public: false, services: risorse([['user-db', 'rds']]) },
            ],
          },
        ],
        noVpc: risorse([['image-resizer', 'lambda'], ['nightly-bi-refresh', 'lambda'], ['public-assets', 's3']]),
      },
      {
        account: 'staging',
        label: 'Staging',
        color: '#13c2c2',
        vpcs: [
          {
            id: 'vpc-0bb2',
            name: 'staging-vpc',
            cidr: '10.30.0.0/16',
            nat: 1,
            igw: true,
            subnets: [
              { id: 'subnet-2a', name: 'public-a', az: 'eu-central-1a', public: true, services: risorse([['legacy-api', 'ec2']]) },
              { id: 'subnet-2b', name: 'private-a', az: 'eu-central-1a', public: false, services: risorse([['sessions', 'elasticache']]) },
            ],
          },
        ],
        noVpc: risorse([['notifier', 'lambda'], ['nightly-report', 'lambda']]),
      },
    ],
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
          resources: ['arn:aws:lambda:eu-west-1:444455556666:function:demo-staging-webhook'],
        },
      ],
      entities: { roles: ['demo-staging-webhook-role'], users: [], groups: [] },
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
      permissionSet: 'reporting-db-operator',
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

export function demoSecurity(lang = 'it') {
  const L = lang === 'en' ? 'en' : 'it'
  const t = makeT(L)
  return {
    findings: [
      { category: 'public', severity: 'high', account: 'staging', accountLabel: 'Staging', resource: 'legacy-api', detail: t('sec.sgOpen', { proto: 'tcp', ports: '22 (SSH)' }) },
      { category: 'public', severity: 'high', account: 'prod', accountLabel: 'Production', resource: 'public-assets', detail: t('sec.s3NoPab'), link: { view: 'resource', account: 'prod', needle: 'public-assets' } },
      { category: 'public', severity: 'info', account: 'prod', accountLabel: 'Production', resource: 'public-lb', detail: t('sec.albPublic'), link: { view: 'resource', account: 'prod', needle: 'public-lb' } },
      { category: 'expiring', severity: 'medium', account: 'prod', accountLabel: 'Production', resource: 'shop.example.com', detail: t('sec.certExpiring', { n: 12 }) },
      { category: 'iam', severity: 'high', account: 'prod', accountLabel: 'Production', resource: 'legacy-admin', detail: t('sec.policyAdmin'), link: { view: 'policy', account: 'prod', arn: 'arn:aws:iam::111122223333:policy/legacy-admin' } },
      { category: 'iam', severity: 'medium', account: 'staging', accountLabel: 'Staging', resource: 'ci-deployer', detail: t('sec.userNoMfa') },
      { category: 'iam', severity: 'medium', account: 'prod', accountLabel: 'Production', resource: 'legacy-bot', detail: t('sec.keyOld', { n: 240 }) },
      { category: 'secret', severity: 'medium', account: 'prod', accountLabel: 'Production', resource: 'prod/user-db', detail: t('sec.secretStale', { n: 210 }), link: { view: 'resource', account: 'prod', needle: 'prod/user-db' } },
    ],
  }
}

// WAF demo: una zona con un blocco che MORDE (regola custom che ferma un percorso applicativo — il
// caso vero: richieste legittime perse in silenzio), una regola in `log` che non ferma niente (per
// mostrare che le due colonne non si sommano) e una zona pulita.
export function demoWaf() {
  return {
    hours: 24,
    zones: [
      {
        zone: 'example.com',
        zoneId: 'demo-zone-1',
        blocked: 1743,
        logged: 20488,
        rules: [
          {
            ruleId: '7c9f2a10',
            action: 'block',
            source: 'firewallCustom',
            sourceKind: 'custom',
            blocking: true,
            count: 1690,
            hosts: ['app.example.com'],
            paths: ['/api/v1/orders', '/api/v1/orders/draft'],
          },
          { ruleId: 'ratelimit-42', action: 'block', source: 'ratelimit', sourceKind: 'ratelimit', blocking: true, count: 53, hosts: ['app.example.com'], paths: ['/api/v1/search'] },
          { ruleId: 'ce-managed-1', action: 'log', source: 'waf', sourceKind: 'managed', blocking: false, count: 20488, hosts: ['app.example.com'], paths: [] },
        ],
        hosts: [{ host: 'app.example.com', count: 1743 }],
      },
      { zone: 'static.example.com', zoneId: 'demo-zone-2', blocked: 0, logged: 12, rules: [], hosts: [] },
    ],
  }
}

// Budget demo: uno già sforato, uno che ci finirà (proiezione oltre il limite mentre il consumo è
// ancora sotto — il caso che si vede solo se mostri entrambe le cifre), uno tranquillo. Più due
// anomalie di costo, quella grossa in cima.
export function demoBudgets() {
  // Lo speso di ogni budget è una FETTA VERA dei costi demo, e la proiezione esce dallo stesso
  // run-rate della pagina Spesa: prima i budget erano cifre a sé (4380 $ su un lordo di 837,60 $) e
  // due riquadri della stessa schermata raccontavano bolletta diverse. Il livello lo decide la stessa
  // budgetLevel() del percorso reale, così un badge non può smentire la sua barra.
  const period = demoPeriod()
  const p = monthEndProjection({ gross: 1, total: 1, period })
  const rate = p ? p.gross : 1 // fine mese / MTD
  // forecastOverride serve ai budget NON mensili: il run-rate qui sopra è quello del mese, applicarlo
  // a un trimestre proietterebbe un periodo che non è il suo.
  const b = (name, limit, actual, timeUnit = 'MONTHLY', forecastOverride = null) => {
    const forecast = forecastOverride ?? actual * rate
    const actualPct = Math.round((actual / limit) * 100)
    const forecastPct = Math.round((forecast / limit) * 100)
    return {
      name,
      type: 'COST',
      unit: 'USD',
      timeUnit,
      limit,
      actual,
      forecast,
      actualPct,
      forecastPct,
      level: budgetLevel({ actualPct, forecastPct }),
    }
  }
  return {
    accounts: {
      management: {
        label: 'Management (payer)',
        color: '#722ed1',
        budgets: [
          // 520,40 = Bedrock (402, Production) + Claude via Marketplace (118,40): l'AI è il 62% della
          // spesa demo, ed era l'unica banda senza un budget addosso.
          b('ai-monthly', 500, 520.4),
          b('org-monthly', 2000, 837.6),
          b('codebuild-monthly', 60, 14.2),
        ],
      },
      prod: {
        label: 'Production',
        color: '#cf1322',
        budgets: [
          b('rds-monthly', 240, 88.0),
          // Trimestrale, e serve a mostrare il quarto stato: consumo oltre l'80% ma proiezione ancora
          // dentro il limite — il caso che un badge sul solo speso, o sulla sola proiezione, non vede.
          b('savings-plan-quarterly', 3000, 2520, 'QUARTERLY', 2880),
        ],
      },
      staging: { label: 'Staging', color: '#1677ff', budgets: [b('staging-monthly', 200, 51.2)] },
    },
    anomalies: [
      {
        id: 'demo-anom-1',
        start: midnightDaysAgo(4),
        end: null,
        service: 'Amazon Bedrock',
        region: 'eu-central-1',
        account: 'Production',
        usageType: 'EUC1-InputTokenCount',
        impact: 412.5,
        expected: 180.2,
        actual: 592.7,
        impactPct: 229,
        feedback: null,
      },
      {
        id: 'demo-anom-2',
        start: midnightDaysAgo(7),
        end: midnightDaysAgo(6),
        service: 'AWS Lambda',
        region: 'eu-central-1',
        account: 'Staging',
        usageType: 'EUC1-Lambda-GB-Second',
        impact: 18.4,
        expected: 4.1,
        actual: 22.5,
        impactPct: 449,
        feedback: 'YES',
      },
    ],
  }
}

// Sprechi demo. Prima la demo rispondeva `{}` e la pagina diceva «nessun account con risorse»: da
// voce di menu a sé passava per una flotta pulita, ma ora è la scheda accanto ai Costi — chi apre la
// demo ci clicca, e una scheda vuota nella vitrina si legge come rotta.
export function demoWaste() {
  return {
    prod: {
      label: 'Production',
      estMonthlyUsd: 78.4,
      eips: [{ id: 'eipalloc-0a1', ip: '52.31.44.7' }, { id: 'eipalloc-0b2', ip: '52.31.44.19' }],
      volumes: [
        { id: 'vol-04d7f1a', sizeGb: 200 },
        { id: 'vol-09be332', sizeGb: 100 },
      ],
      natGateways: [{ id: 'nat-0f2c81b' }],
      idleDatabases: [{ id: 'legacy-reporting', cpuAvg: 1.2, cpuMax: 4.8 }],
    },
    staging: {
      label: 'Staging',
      estMonthlyUsd: 10.8,
      eips: [{ id: 'eipalloc-0c3', ip: '3.71.9.22' }],
      idleInstances: [{ id: 'i-0ab12cd34', type: 't3.medium', cpuAvg: 0.9, cpuMax: 3.1 }],
    },
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

// Tre replica dello stesso servizio, di cui una che consuma il triplo di CPU delle altre: è il caso
// che le medie di servizio nascondono, e la ragione per cui questa vista esiste.
export function demoTaskMetrics() {
  const now = Date.now()
  return {
    logGroup: '/aws/ecs/containerinsights/demo-cluster/performance',
    revisions: ['57'],
    tasks: [
      // Il primo consuma il triplo degli altri ED è fuori dal target group: è il caso in cui "task
      // attivi 3/3" è verde e il servizio, per chi lo usa, sta perdendo un terzo delle richieste.
      { taskId: '3f7a91c2e5b84d16a0c9f2e7b1d48a35', shortId: '3f7a91c2', az: 'eu-central-1a', revision: '57', status: 'RUNNING', health: 'UNHEALTHY', cpuPct: 61.4, memPct: 88.2, diskPct: 34.1, cpuReserved: 512, memReserved: 1024, netRxBytes: 1_284_320, netTxBytes: 903_112, netDropped: 12, netErrors: 0, pullMs: 4200, latency: { requests: 412, errors: 7, p50: 180, p95: 1240, p99: 2100, max: 3400 }, ts: now - 30_000, startedAt: now - 5_400_000, target: { state: 'unhealthy', reason: 'Target.ResponseCodeMismatch', description: 'Health checks failed with these codes: [503]', port: 8080 } },
      { taskId: 'b82d4e6f1a9c47b38e5d0f2a6c71b849', shortId: 'b82d4e6f', az: 'eu-central-1b', revision: '57', status: 'RUNNING', health: 'HEALTHY', cpuPct: 19.8, memPct: 44.6, diskPct: 21.7, cpuReserved: 512, memReserved: 1024, netRxBytes: 1_102_884, netTxBytes: 812_004, netDropped: 0, netErrors: 0, pullMs: 3900, latency: { requests: 430, errors: 0, p50: 96, p95: 210, p99: 380, max: 520 }, ts: now - 30_000, startedAt: now - 5_400_000, target: { state: 'healthy', reason: null, description: null, port: 8080 } },
      { taskId: 'c14f8a20d7e34b95af61c803e9b2d5f7', shortId: 'c14f8a20', az: 'eu-central-1c', revision: '57', status: 'RUNNING', health: 'HEALTHY', cpuPct: 17.2, memPct: 43.1, diskPct: 20.4, cpuReserved: 512, memReserved: 1024, netRxBytes: 1_057_260, netTxBytes: 798_431, netDropped: 0, netErrors: 0, pullMs: 4050, latency: { requests: 418, errors: 0, p50: 92, p95: 205, p99: 372, max: 495 }, ts: now - 30_000, startedAt: now - 5_400_000, target: { state: 'healthy', reason: null, description: null, port: 8080 } },
    ],
    latencySource: { available: true, objects: 6, window: 15 },
    stopped: [
      { taskId: 'd9e0f1a2b3c44d5e6f708192a3b4c5d6', shortId: 'd9e0f1a2', stoppedAt: now - 1_800_000, stoppedReason: 'Essential container in task exited', stopCode: 'EssentialContainerExited', containerReasons: ['OutOfMemoryError: Container killed due to memory usage'], exitCodes: [137], kind: 'oom' },
      { taskId: 'e1f2a3b4c5d6470819a2b3c4d5e6f708', shortId: 'e1f2a3b4', stoppedAt: now - 7_200_000, stoppedReason: 'Scaling activity initiated by deployment ecs-svc/123', stopCode: 'ServiceSchedulerInitiated', containerReasons: [], exitCodes: [], kind: 'scheduler' },
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

// Trend demo: la spesa AWS nasce con la migrazione (mesi vuoti prima) e l'ultimo mese è PARZIALE —
// così la demo mostra anche il tratteggio, che è la parte facile da sbagliare guardando un grafico.
export function demoCostTrend() {
  const mk = (month, usage, ai, credits, partial = false) => ({
    month,
    usage,
    aiUsage: ai,
    infraUsage: usage - ai,
    tax: 0,
    credits,
    invoiced: usage + credits,
    partial,
  })
  // I mesi finiscono con quello CORRENTE (l'ultimo parziale): la curva è la stessa, ma le etichette
  // seguono l'oggi invece di restare ferme al giorno in cui sono state scritte.
  const M = demoMonths(13)
  const series = (rows) => rows.map(([usage, ai, credits], i) => mk(M[i], usage, ai, credits, i === rows.length - 1))
  return {
    prod: {
      label: 'Production',
      color: '#cf1322',
      currency: 'USD',
      months: series([
        [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
        [12, 0, -12], [48, 4, -46], [96, 22, -88], [410, 180, -370], [1180, 720, -1010],
        [640, 402, -545],
      ]),
    },
    staging: {
      label: 'Staging',
      color: '#1677ff',
      currency: 'USD',
      months: series([
        [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
        [3, 0, -3], [11, 0, -10], [24, 2, -22], [78, 9, -70], [132, 14, -118],
        [61, 6, -52],
      ]),
    },
  }
}

// Componenti demo: un `null` in mezzo (risorse non taggate) perché è il caso vero più comune — e
// nascondere il non-taggato farebbe sembrare l'attribuzione completa quando non lo è.
export function demoCostComponents() {
  return {
    prod: {
      label: 'Production',
      color: '#cf1322',
      currency: 'USD',
      tagKey: 'component',
      period: demoPeriod(),
      components: [
        {
          component: 'reporting-db',
          amount: 148.2,
          services: [
            { service: 'Amazon Relational Database Service', amount: 141.0 },
            { service: 'Amazon Simple Storage Service', amount: 7.2 },
          ],
        },
        {
          component: 'backend',
          amount: 62.4,
          services: [
            { service: 'Amazon Elastic Container Service', amount: 58.1 },
            { service: 'Amazon Elastic Load Balancing', amount: 4.3 },
          ],
        },
        { component: null, amount: 31.1, services: [{ service: 'EC2 - Other', amount: 31.1 }] },
        { component: 'bastion', amount: 10.1, services: [{ service: 'Amazon Elastic Load Balancing', amount: 10.1 }] },
      ],
    },
    staging: {
      label: 'Staging',
      color: '#1677ff',
      currency: 'USD',
      tagKey: 'component',
      period: demoPeriod(),
      components: [
        { component: 'backend', amount: 28.4, services: [{ service: 'Amazon Elastic Container Service', amount: 28.4 }] },
        { component: 'redis', amount: 18.0, services: [{ service: 'Amazon ElastiCache', amount: 18.0 }] },
      ],
    },
  }
}

// Livelli demo (Cost Category «Livello»): un `null` in mezzo perché la spesa non categorizzata è il
// caso vero più comune, e vederla è il punto — una categorizzazione incompleta nascosta si legge come
// completa.
export function demoCostCategories() {
  const svc = (service, amount) => ({ service, amount })
  return {
    prod: {
      label: 'Production',
      color: '#cf1322',
      currency: 'USD',
      categoryName: 'Livello',
      period: demoPeriod(),
      categories: [
        { category: 'llms', amount: 402.0, services: [svc('Amazon Bedrock', 402.0)] },
        {
          category: 'compute',
          amount: 154.7,
          services: [svc('Amazon Elastic Container Service', 142.3), svc('AWS Lambda', 12.4)],
        },
        { category: 'database', amount: 88.0, services: [svc('Amazon RDS', 88.0)] },
        { category: null, amount: 9.1, services: [svc('Amazon CloudFront', 9.1)] },
      ],
    },
    staging: {
      label: 'Staging',
      color: '#1677ff',
      currency: 'USD',
      categoryName: 'Livello',
      period: demoPeriod(),
      categories: [
        { category: 'compute', amount: 33.2, services: [svc('Amazon Elastic Container Service', 33.2)] },
        { category: 'database', amount: 18.0, services: [svc('Amazon ElastiCache', 18.0)] },
      ],
    },
    management: {
      label: 'Management (payer)',
      color: '#722ed1',
      currency: 'USD',
      categoryName: 'Livello',
      period: demoPeriod(),
      categories: [
        { category: 'llms', amount: 118.4, services: [svc('AWS Marketplace (Claude Sonnet)', 118.4)] },
        { category: 'deploy', amount: 14.2, services: [svc('CodeBuild', 14.2)] },
      ],
    },
  }
}

// Il filtro Livello applicato ai dati finti. Una demo che mostra un menu inerte insegna che il menu
// non serve: qui il filtro agisce davvero, usando la mappa livello→servizi delle categorie demo
// (l'unica fonte di verità della finzione, così le due viste non si contraddicono).
//
// Il TREND resta non filtrato: i dati demo non hanno una ripartizione per livello mese per mese, e
// inventarne una significherebbe disegnare una forma che non deriva da nulla. In cloud il filtro
// arriva a Cost Explorer e il trend lo rispetta.
export function demoApplyType(costs, type) {
  if (!type || type === 'all') return costs
  const cats = demoCostCategories()
  const out = {}
  for (const [key, acc] of Object.entries(costs)) {
    const wanted = new Set(
      (cats[key]?.categories ?? []).filter((c) => c.category === type).flatMap((c) => c.services.map((s) => s.service)),
    )
    const items = (acc.items ?? []).filter((i) => wanted.has(i.service))
    const gross = items.reduce((n, i) => n + i.amount, 0)
    const aiGross = items.filter((i) => /bedrock|marketplace/i.test(i.service)).reduce((n, i) => n + i.amount, 0)
    out[key] = {
      ...acc,
      items,
      gross,
      aiGross,
      infraGross: gross - aiGross,
      // Crediti e tasse NON si filtrano per livello: sono voci di conto, non di risorsa. Con un
      // livello selezionato spariscono dal quadro, come fa Cost Explorer con un filtro attivo.
      credits: 0,
      tax: 0,
      total: gross,
      net: gross,
      projection: monthEndProjection({ gross, total: gross, period: acc.period }),
    }
  }
  return out
}

// Esecuzioni: la vista che dice «cosa sta girando ADESSO» e «com'è finita quella di stanotte».
// Il dataset è scelto per mostrare i casi che contano e che le card non sanno raccontare: uno scraper
// LUNGO a metà corsa, un cron che ha finito con exit code 0 ma con dei traceback dentro, uno ucciso
// per memoria, uno andato in timeout, uno spento di proposito, e i job di un orchestratore esterno
// che in AWS non comparirebbero affatto.
export function demoRuns() {
  const now = Date.now()
  const min = 60_000
  const run = (o) => ({ failedScanned: true, source: 'log', ...o })

  const crawler = {
    key: 'prod/catalog-crawler',
    name: 'catalog-crawler',
    type: 'ecs-scheduled',
    account: 'prod',
    accountLabel: 'Production',
    color: '#cf1322',
    region: 'eu-west-1',
    cluster: 'arn:aws:ecs:eu-west-1:000000000000:cluster/demo-cluster',
    family: 'demo-cron-catalog-crawler',
    logGroup: '/ecs/demo/cron-catalog-crawler',
    scheduleExpr: 'cron(0 3 * * ? *)',
    scheduleMinutes: 1440,
    scheduleTz: 'Europe/Rome',
    enabled: true,
    nextRunAt: now + 9 * 60 * min,
    runs: [
      // In corso: 22 minuti di lavoro, nessuna fine. È la riga per cui questa pagina esiste.
      run({ id: '7c1d9e3fa5b24c08b9e6d1a4c7f30b52', startedAt: now - 22 * min, endedAt: null, running: true, outcome: 'running', source: 'both', stream: 'cron/crawler/7c1d9e3fa5b24c08b9e6d1a4c7f30b52' }),
      // Finita "bene" per ECS (exit 0) ma con errori nei log: la card sarebbe verde, la run no.
      run({ id: '2b8f47ac91d3405e8f7c2a6b0d94e138', startedAt: now - 1500 * min, endedAt: now - 1443 * min, running: false, exitCode: 0, outcome: 'failed', stream: 'cron/crawler/2b8f47ac91d3405e8f7c2a6b0d94e138' }),
      // Uccisa per memoria: il log non lo dice, l'API ECS sì. Ecco perché servono due sorgenti.
      run({ id: 'f0a3c85d7e19426bb2d8f60a1c53e947', startedAt: now - 2940 * min, endedAt: now - 2902 * min, running: false, exitCode: 137, stopCode: 'EssentialContainerExited', stopReason: 'OutOfMemoryError: Container killed due to memory usage', outcome: 'failed', source: 'both', stream: 'cron/crawler/f0a3c85d7e19426bb2d8f60a1c53e947' }),
      run({ id: 'a5e2708c4b6d41f9ae30c8b52d71f064', startedAt: now - 4380 * min, endedAt: now - 4322 * min, running: false, exitCode: 0, outcome: 'ok', stream: 'cron/crawler/a5e2708c4b6d41f9ae30c8b52d71f064' }),
    ],
  }

  const digest = {
    key: 'prod/daily-digest',
    name: 'daily-digest',
    type: 'lambda',
    account: 'prod',
    accountLabel: 'Production',
    color: '#cf1322',
    region: 'eu-west-1',
    function: 'daily-digest',
    logGroup: '/aws/lambda/daily-digest',
    scheduleExpr: 'cron(0 6 * * ? *)',
    scheduleMinutes: 1440,
    scheduleTz: 'Europe/Rome',
    enabled: true,
    nextRunAt: now + 12 * 60 * min,
    runs: [
      run({ id: '3f9c1a20-5d7e-4b81-9c02-6ad4e7f13b58', startedAt: now - 240 * min, endedAt: now - 240 * min + 4200, durationMs: 4187, billedMs: 4200, maxMemoryMb: 118, running: false, outcome: 'ok' }),
      // Timeout: il REPORT c'è, ma la funzione non ha finito il lavoro.
      run({ id: '8b04d7e1-93af-42c6-8e75-1c0b6a9d24f3', startedAt: now - 1680 * min, endedAt: now - 1680 * min + 300_000, durationMs: 300_020, billedMs: 300_000, maxMemoryMb: 204, timedOut: true, running: false, outcome: 'failed' }),
      run({ id: 'c72e5a91-04bd-4f38-a6d1-9e28b7c05f4a', startedAt: now - 3120 * min, endedAt: now - 3120 * min + 3900, durationMs: 3902, billedMs: 3900, maxMemoryMb: 112, running: false, outcome: 'ok' }),
    ],
  }

  const legacy = {
    key: 'staging/invoice-retry',
    name: 'invoice-retry',
    type: 'lambda',
    account: 'staging',
    accountLabel: 'Staging',
    color: '#1677ff',
    region: 'eu-west-1',
    function: 'invoice-retry',
    scheduleExpr: 'rate(15 minutes)',
    scheduleMinutes: 15,
    enabled: false, // spento di proposito: resta in elenco, non diventa un allarme
    nextRunAt: null,
    runs: [],
  }

  const withSummary = (c) => ({
    ...c,
    running: c.runs.filter((r) => r.running).length,
    failedShown: c.runs.filter((r) => r.outcome === 'failed').length,
    lastOutcome: c.runs.find((r) => !r.running)?.outcome ?? (c.runs.length ? 'running' : null),
    lastRunAt: c.runs[0]?.startedAt ?? null,
  })

  return {
    window: 4320,
    truncated: false,
    crons: [crawler, digest, legacy].map(withSummary),
    problems: [],
    prefect: {
      runs: [
        { id: 'd41f8a62-7b30-4c95-8e12-5f0a9c3b7d64', cron: 'portal-scrape', runName: 'bold-hedgehog', startedAt: now - 47 * min, endedAt: null, durationMs: null, running: true, outcome: 'running', state: 'Running', failedScanned: true, source: 'prefect' },
        { id: '9a25c703-1e48-4bd6-af91-3c72e0b58d14', cron: 'portal-scrape', runName: 'keen-otter', startedAt: now - 1490 * min, endedAt: now - 1436 * min, durationMs: 54 * min, running: false, outcome: 'failed', state: 'Crashed', failedScanned: true, source: 'prefect' },
        { id: '5e7b0c48-92da-4f16-b703-8c1e5a9d2740', cron: 'attachment-fetch', runName: 'calm-lynx', startedAt: now - 2900 * min, endedAt: now - 2880 * min, durationMs: 20 * min, running: false, outcome: 'ok', state: 'Completed', failedScanned: true, source: 'prefect' },
      ],
    },
    generatedAt: now,
  }
}

// I log di una esecuzione, in demo: abbastanza righe da far vedere come si legge un fallimento.
export function demoRunLogs(query = {}) {
  const now = Date.now()
  const errori = String(query.errorsOnly) === 'true'
  const events = [
    { ts: now - 1_320_000, message: JSON.stringify({ level: 'info', msg: 'run started', pages: 480 }) },
    { ts: now - 1_200_000, message: JSON.stringify({ level: 'info', msg: 'page batch done', batch: 1, items: 120 }) },
    { ts: now - 900_000, message: JSON.stringify({ level: 'warn', msg: 'rate limited, backing off', seconds: 30 }) },
    { ts: now - 600_000, message: 'Traceback (most recent call last):' },
    { ts: now - 600_000, message: '  File "crawler/fetch.py", line 214, in fetch_page' },
    { ts: now - 600_000, message: 'TimeoutError: page load exceeded 60s' },
    { ts: now - 480_000, message: JSON.stringify({ level: 'info', msg: 'page batch done', batch: 2, items: 118 }) },
  ]
  return {
    logGroup: '/ecs/demo/cron-catalog-crawler',
    events: errori ? events.filter((e) => /Traceback|Error|error/.test(e.message)) : events,
    truncated: false,
    healthSkipped: 0,
    streams: ['cron/crawler/7c1d9e3fa5b24c08b9e6d1a4c7f30b52'],
  }
}

export function demoApplyTypeComponents(comps, type) {
  if (!type || type === 'all') return comps
  const cats = demoCostCategories()
  const out = {}
  for (const [key, acc] of Object.entries(comps)) {
    const wanted = new Set(
      (cats[key]?.categories ?? []).filter((c) => c.category === type).flatMap((c) => c.services.map((s) => s.service)),
    )
    const components = (acc.components ?? [])
      .map((c) => {
        const services = c.services.filter((s) => wanted.has(s.service))
        return { ...c, services, amount: services.reduce((n, s) => n + s.amount, 0) }
      })
      .filter((c) => c.services.length > 0)
    out[key] = { ...acc, components }
  }
  return out
}
