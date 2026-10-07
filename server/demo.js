// Demo / sandbox: dataset FINTO, zero credenziali AWS. Stessa forma di getStatus & co.
// Serve a (a) provare Dadaguard senza wiring AWS, (b) registrare la GIF di lancio,
// (c) valutare la UI. Attivo con env DADAGUARD_DEMO=1 (vedi mode.js: isDemo).
// Tutto statico e read-only: nessuna chiamata di rete.
import { budgetLevel } from './budgets.js'
import { monthEndProjection } from './costs.js'
import { computeOverall } from './status.js'
import { makeT } from './i18n.js'
import { componiStorico } from './storico.js'
import { arricchisciServizio } from './meta/stato.js'
import { metaDaTags, CHIAVI } from './meta/tags.js'
import { budgetErrore, conteggiDaRuntime } from './meta/budget.js'
import { linkServizio, linkDeploy } from './meta/link.js'
import { aggregaGiorni } from './meta/spesa.js'
import { durataTipica } from './meta/cron.js'
import { andamentoAudit, passoAndamento, settimanaDiSalute } from './teleport.js'
import { componiFlotta } from './flotta.js'
import { SOGLIE_DEV_ENV } from './accessi.js'

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

// I metadati della UI nuova sui servizi demo: tag `dadaguard:*` finti (team, canale, runbook, SLO e
// nome nei log di PostHog, volutamente diverso dal nome della risorsa come succede davvero),
// conteggi per il budget di errore e un progetto PostHog d'esempio, cosi' la demo mostra ogni campo.
// In reale arrivano dai tag della risorsa e dai conteggi del check runtime, qui sono scritti a mano
// perche' la demo non ha una risorsa da cui leggerli.
const DEMO_TAGS = {
  'checkout-api': { team: 'payments', slack: '#team-payments', runbook: 'https://wiki.example.com/runbook/checkout', slo: '99.9', posthog: 'shop-checkout-api', conteggi: { totali: 184_000, errori: 35 } },
  'payments-worker': { team: 'payments', slack: '#team-payments', runbook: 'https://wiki.example.com/runbook/payments', slo: '99.9', posthog: 'shop-payments-worker', conteggi: { totali: 6_200, errori: 260 } },
  'image-resizer': { team: 'media', slack: '#team-media', runbook: 'https://wiki.example.com/runbook/image-resizer', slo: '99.5', conteggi: { totali: 1_900, errori: 41 } },
  notifier: { team: 'growth', slack: '#team-growth', runbook: 'https://wiki.example.com/runbook/notifier', slo: '99', conteggi: { totali: 3_400, errori: 12 } },
  web: { team: 'web', slack: '#team-web', slo: '99.9', posthog: 'shop-web', conteggi: { totali: 92_000, errori: 6 } },
  'cdn-cert': { team: 'devops', slack: '#team-devops' },
  'user-db': { team: 'devops', slack: '#team-devops', runbook: 'https://wiki.example.com/runbook/database' },
}
const DEMO_POSTHOG = { host: 'https://eu.posthog.example.com', projectId: '12345' }
function demoAws(r) {
  if (r.type === 'lambda') return { type: 'lambda', function: r.name }
  if (r.type === 'ecs') return { type: 'ecs', cluster: 'demo-cluster', service: r.name }
  if (r.type === 'rds') return { type: 'rds', cluster: r.name }
  if (r.type === 'acm') return { type: 'acm', arn: `arn:aws:acm:us-east-1:000000000000:certificate/demo-${r.name}` }
  return { type: r.type }
}
function demoMeta(r) {
  const d = DEMO_TAGS[r.name] ?? {}
  const meta = metaDaTags(
    d.team || d.slo ? { [CHIAVI.team]: d.team, [CHIAVI.slack]: d.slack, [CHIAVI.runbook]: d.runbook, [CHIAVI.slo]: d.slo, [CHIAVI.posthog]: d.posthog } : null,
  )
  const conteggi = d.conteggi ? { ...d.conteggi, finestra: '1h' } : conteggiDaRuntime(r.checks?.runtime)
  const aws = demoAws(r)
  const cf = r.account?.key === 'cloudflare'
  return arricchisciServizio(
    {
      ...meta,
      budgetErrore: meta.slo && conteggi ? budgetErrore({ slo: meta.slo, ...conteggi }) : null,
      altrove: cf ? [] : linkServizio({ aws, region: r.region, posthog: DEMO_POSTHOG, servizioPosthog: meta.posthog }),
      ...r,
    },
    { aws, profile: cf ? null : `demo-${r.account?.key ?? 'prod'}`, region: r.region, ssmPath: `/demo/${r.name}`, repoDir: '/path/to/terraform-repo' },
  )
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
    services: services.map(demoMeta),
    // ⚠️ Un allarme che sta suonando e che NESSUN servizio possiede: e' il caso che la flotta non puo'
    // mostrare, perche' li' gli allarmi si correlano per dimensione e questo non ne ha (nasce da un
    // metric filter su un log group, cioe' conta righe e non risorse). Sta nella demo per la stessa
    // ragione per cui ci stanno i quattro stati dei budget: se un pannello non lo si vede mai, chi
    // guarda la demo non sa che esiste.
    alarmiOrfani: [
      {
        nome: 'audit-sessioni-db-negate',
        motivo: 'Threshold Crossed: 1 datapoint [3.0] was greater than or equal to the threshold (2.0).',
        da: midnightDaysAgo(0),
        account: 'security',
        accountLabel: 'Security',
      },
    ],
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
    const d = {
      id: `demo-${env}-${service}-deploy:demo-${number}`,
      arn: `arn:aws:codebuild:eu-west-1:000000000000:build/demo-${env}-${service}-deploy:demo-${number}`,
      repo: `https://github.com/example-org/${service}`,
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
    return { ...d, altrove: linkDeploy(d) }
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
      assignments: [{ account: 'Production', type: 'group', name: 'admins', members: ['alex', 'sam'] }],
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
          { account: 'Production', type: 'group', name: 'platform-admins', members: ['sam.bianchi', 'alice.rossi'] },
          { account: 'Staging', type: 'group', name: 'platform-admins', members: ['sam.bianchi', 'alice.rossi'] },
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

// Il RITMO del mese per la demo: quante volte l'MTD sta in un mese intero.
//
// ⚠️ Ha un pavimento, e non è prudenza generica. `demoPeriod()` ferma la finestra al giorno 13 perché
// un MTD non può coprire giorni futuri, ma sotto quel giorno la finestra è corta davvero: il primo
// del mese l'MTD è di UN giorno, il fattore di proiezione vale 30, e ogni budget demo finisce oltre
// il limite. Il 01/09/2026 la pagina mostrava un solo stato su quattro (nessun budget verde) e la
// prova che li pretende tutti e quattro era rossa, insieme a tutta la pipeline.
// Il pavimento è lo stesso giorno a cui la finestra si ferma: da lì in poi il ritmo è quello vero,
// prima la demo non finge di conoscere un ritmo che con un giorno di dati non esiste. Il PERIODO non
// si allunga, che è la regola opposta e resta valida.
export const RITMO_GIORNI_MINIMI = 12
export function demoRitmo(now = new Date()) {
  const p = monthEndProjection({ gross: 1, total: 1, period: demoPeriod(now) })
  const giorniMese = p?.daysInMonth ?? 30
  return giorniMese / Math.max(p?.daysElapsed ?? RITMO_GIORNI_MINIMI, RITMO_GIORNI_MINIMI)
}

// Budget demo: uno già sforato, uno che ci finirà (proiezione oltre il limite mentre il consumo è
// ancora sotto — il caso che si vede solo se mostri entrambe le cifre), uno tranquillo. Più due
// anomalie di costo, quella grossa in cima.
export function demoBudgets() {
  // Lo speso di ogni budget è una FETTA VERA dei costi demo, e la proiezione esce dallo stesso
  // run-rate della pagina Spesa: prima i budget erano cifre a sé (4380 $ su un lordo di 837,60 $) e
  // due riquadri della stessa schermata raccontavano bolletta diverse. Il livello lo decide la stessa
  // budgetLevel() del percorso reale, così un badge non può smentire la sua barra.
  const rate = demoRitmo() // fine mese / MTD, col pavimento: vedi demoRitmo()
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

// Accessi (audit del cluster + heartbeat dei dev-env). In demo la pagina rispondeva «manca la sezione
// `teleport:` nella config», cioè una pagina vuota su una funzione che esiste: chi lancia l'immagine
// pubblica per valutare la UI non ha modo di vederla. Stessa ragione per cui la Rete ha i suoi dati
// finti.
//
// La finestra la sceglie chi guarda (24h / 48h / 7g), quindi i VOLUMI si scalano: un dataset che non
// cambia cambiando finestra fa sembrare rotto l'interruttore. Le righe restano le stesse, perché in
// sette giorni sono le stesse persone e le stesse macchine.
//
// La flotta finta mostra TUTTI gli stati che la pagina sa segnalare: chi è chiuso fuori dal login e
// perché, una scrittura su un database di produzione, una sessione SSH ancora aperta, un'immagine
// rimasta indietro e una macchina con dei tool mancanti. Una demo dove va tutto bene non fa vedere
// niente di quello che la pagina serve a vedere.
export function demoTeleport(ore = 24) {
  const now = Date.now()
  const f = Math.max(1, ore / 24)
  const su = (n) => Math.round(n * f)
  const persone = [
    { utente: 'alex', loginOk: su(9), loginFallite: 0, motivo: null, primaFallita: null, ultimaFallita: null, sessioniDb: su(6), query: su(184), scritture: 0, sessioniSsh: 0, ultima: now - 4 * 60_000 },
    { utente: 'rin', loginOk: su(7), loginFallite: 0, motivo: null, primaFallita: null, ultimaFallita: null, sessioniDb: su(68), query: su(1487), scritture: 0, sessioniSsh: 3, ultima: now - 22 * 60_000 },
    // Chi è chiuso fuori, col motivo per intero: è la riga per cui la pagina esiste.
    { utente: 'sam', loginOk: 0, loginFallite: su(3), motivo: 'role "db-writer" is not found', primaFallita: now - 21 * 60_000, ultimaFallita: now - 9 * 60_000, sessioniDb: 0, query: 0, scritture: 0, sessioniSsh: 0, ultima: now - 9 * 60_000 },
    { utente: 'noa', loginOk: su(4), loginFallite: su(1), motivo: 'access denied: MFA required', primaFallita: now - 3 * 3600_000, ultimaFallita: now - 3 * 3600_000, sessioniDb: su(14), query: su(28), scritture: 0, sessioniSsh: 0, ultima: now - 51 * 60_000 },
    { utente: 'kim', loginOk: su(4), loginFallite: 0, motivo: null, primaFallita: null, ultimaFallita: null, sessioniDb: su(101), query: su(116), scritture: su(5), sessioniSsh: 0, ultima: now - 3 * 3600_000 },
    // Un accesso al database NEGATO: lee chiede `postgres` al tunnel di sola lettura, che non lo concede.
    {
      utente: 'lee',
      loginOk: su(2),
      loginFallite: 0,
      motivo: 'access to db denied: user postgres is not allowed',
      primaFallita: null,
      ultimaFallita: null,
      sessioniDb: su(1),
      sessioniDbNegate: su(2),
      negati: [{ utente: 'lee', dbUser: 'postgres', nome: 'orders', servizio: 'orders-prod-db-ro', quante: su(2), ultima: now - 33 * 60_000 }],
      query: su(4),
      scritture: 0,
      sessioniSsh: 0,
      ultima: now - 33 * 60_000,
    },
  ]
  const database = [
    { servizio: 'orders-prod-db-ro', nome: 'orders', ambiente: 'prod', query: su(2329), scritture: 0, persone: 4 },
    { servizio: 'app-staging-db', nome: 'postgres', ambiente: 'staging', query: su(95), scritture: su(5), persone: 1 },
    { servizio: 'cache-prod', nome: '?', ambiente: 'prod', query: su(28), scritture: 0, persone: 3 },
    { servizio: 'cache-staging', nome: '?', ambiente: 'staging', query: su(26), scritture: 0, persone: 3 },
    // Una scrittura su un database di PRODUZIONE: il pallino sull'interruttore nasce da questa riga.
    {
      servizio: 'app-production-db',
      nome: 'postgres',
      ambiente: 'prod',
      query: su(9),
      scritture: 2,
      scrittureDati: 2,
      scrittureStruttura: 0,
      azioni: [{ etichetta: 'UPDATE', quante: 2, tipo: 'dati' }],
      bersagli: ['public.orders'],
      persone: 1,
      chi: ['kim'],
      scriventi: ['kim'],
      ultimaScrittura: now - 47 * 60_000,
    },
  ]
  const ssh = [
    // Ancora aperta, e sul Mac di un'ALTRA persona: qualcuno e' dentro adesso, ed e' l'unica riga a cui
    // si reagisce subito.
    { macchina: 'noa-macbook', chi: ['rin'], sessioni: 2, aperte: 1, ultima: now - 12 * 60_000 },
    { macchina: 'alex-macbook', chi: ['rin'], sessioni: 1, aperte: 0, ultima: now - 6 * 3600_000 },
  ]
  const { macchine, storia, IMG } = demoMacchineDevEnv(now)
  const somma = (campo) => persone.reduce((n, p) => n + (p[campo] ?? 0), 0)
  return {
    configurato: true,
    webUrl: 'https://teleport.example.com/web',
    sshCommand: 'tsh ssh dev@{macchina}',
    auditUserUrl: 'https://teleport.example.com/web/audit?user={utente}',
    auditNodeUrl: 'https://teleport.example.com/web/audit?node={macchina}',
    audit: {
      ore,
      persone,
      database,
      ssh,
      sessioniSsh: ssh.reduce((n, m) => n + m.sessioni, 0),
      sshAperte: ssh.reduce((n, m) => n + m.aperte, 0),
      loginFallite: somma('loginFallite'),
      query: somma('query'),
      scritture: somma('scritture'),
      sessioniDb: somma('sessioniDb'),
      sessioniDbNegate: somma('sessioniDbNegate'),
      negati: persone.flatMap((p) => p.negati ?? []),
      troncato: false,
      motivoPiuComune: { motivo: 'role "db-writer" is not found', quante: su(3) },
      andamento: andamentoAudit(demoTracciaAudit(now, ore, persone, database, ssh), { adesso: now, ore }),
    },
    heartbeat: {
      giorni: 7,
      // In demo la versione attesa NON c'e': cosi' la pagina mostra il ripiego («la piu' recente vista»)
      // dichiarato come tale, che e' lo stato in cui si trova chi non ha ancora messo quel campo.
      attesa: null,
      macchine,
      versioni: [
        { immagine: IMG.nuova, quante: 3 },
        { immagine: IMG.vecchia, quante: 1 },
      ],
      conToolMancanti: macchine.filter((m) => m.toolMancanti > 0).length,
      senzaVersione: 1,
      storia,
    },
  }
}

// Gli eventi dell'audit in demo, per il grafico della pagina Accessi: tanti quanti ne dicono i totali
// qui sopra, nella finestra chiesta. L'ultimo di ogni persona sta al suo istante vero quando e' dentro
// la finestra, le raffiche (le login fallite di sam, i negati di lee) sono fitte come una raffica vera,
// e il resto si spande sulla finestra con un passo fisso (niente caso: la stessa demo, lo stesso
// grafico). Poi passano da `andamentoAudit`, la stessa funzione della produzione.
export function demoTracciaAudit(now, ore, persone = [], database = [], ssh = []) {
  // L'inizio della prima fascia, non `now - ore`: le fasce sono allineate, e un evento fra i due
  // cadrebbe fuori dal grafico pur stando nei totali.
  const passo = passoAndamento(ore)
  const da = Math.floor(now / passo) * passo - (Math.ceil((ore * 3600_000) / passo) - 1) * passo
  const ev = []
  const spandi = (n, { tipo, utente, ultima = null, raffica = 0, extra = {} }) => {
    for (let k = 0; k < n; k++) {
      let q = null
      if (ultima != null && ultima >= da && (k === 0 || (raffica > 0 && k < 3))) q = ultima - k * raffica
      if (q == null || q < da) q = da + (((k + 1) * 0.618 + utente.length * 0.137) % 1) * (now - da)
      ev.push({ quando: q, tipo, utente, ...extra })
    }
  }
  for (const p of persone) {
    spandi(p.loginOk ?? 0, { tipo: 'login', utente: p.utente })
    spandi(Math.min(p.sessioniDb ?? 0, 60), { tipo: 'db', utente: p.utente })
    spandi(p.loginFallite ?? 0, { tipo: 'login-fallita', utente: p.utente, ultima: p.ultimaFallita, raffica: 6 * 60_000 })
    for (const n of p.negati ?? []) spandi(n.quante, { tipo: 'negato', utente: p.utente, ultima: n.ultima, raffica: 4 * 60_000 })
  }
  for (const d of database) {
    if (!d.scritture) continue
    const prod = d.ambiente === 'prod'
    const chi = d.chi?.[0] ?? 'kim'
    spandi(d.scritture, { tipo: 'scrittura', utente: chi, ultima: d.ultimaScrittura ?? null, raffica: 5 * 60_000, extra: { prod } })
  }
  for (const m of ssh) for (const u of m.chi ?? []) spandi(m.sessioni ?? 0, { tipo: 'ssh', utente: u, ultima: m.ultima, raffica: 25 * 60_000 })
  return ev
}

// ── La FLOTTA dei dev-env in demo ──────────────────────────────────────────────────────────────────
//
// Le macchine dell'heartbeat (una riga per avvio) e sette giorni di righe di salute (una ogni 15
// minuti), finte ma con la forma vera: passano dalle stesse funzioni della produzione
// (`settimanaDiSalute` e `componiFlotta`), cosi' la demo prova la composizione invece di aggirarla.
//
// La flotta mostra i casi che la pagina sa dire, uno per Mac:
//   · kim: colima, tre processi uccisi per memoria oggi, VM a 11,7 GB su un obiettivo di 14, il backend
//     a 3,7 GB e la memoria libera che scende da una settimana;
//   · sam: l'immagine undici giorni indietro e tre tool mancanti;
//   · noa: due opt-out accesi e il doctor con due controlli KO, piu' un avvio finito a meta';
//   · rin: tanti comandi dei repo lanciati sul Mac invece che nel container;
//   · alex, lee, eli: in ordine.
// Valori calcolati dall'indice della riga e non casuali: la stessa demo disegna le stesse curve.
const ORA = 3_600_000
const GIORNO = 24 * ORA
const DEMO_IMG = {
  nuova: 'sha256:4f21c8a0e9d3b7c15a2f6e08d94b3c71',
  vecchia: 'sha256:9b0e73d4a1c86f52e7d09a4b31c5f860',
  media: 'sha256:5c3a9e1f0b7d24c68e9a1f3b5d7c9e02',
}

export function demoMacchineDevEnv(now = Date.now()) {
  const IMG = DEMO_IMG
  const creata = (giorni) => new Date(now - giorni * GIORNO).toISOString()
  const host = (macchina, utente, dentro = {}) => ({
    macchina,
    lato: 'host',
    utente,
    utenti: [utente],
    immagine: IMG.nuova,
    creata: creata(2),
    esito: 'ok',
    toolMancanti: 0,
    toolMancantiNomi: [],
    durata: 80,
    quando: now - 40 * 60_000,
    ...dentro,
  })
  const macchine = [
    host('alex-macbook', 'alex', { durata: 74 }),
    { macchina: 'alex-macbook', lato: 'container', utente: 'alex', utenti: ['alex'], immagine: IMG.nuova, esito: 'ok', toolMancanti: 0, durata: 41, quando: now - 39 * 60_000 },
    // La stessa persona con due nomi: l'avvio manda l'utente Teleport se c'e' una sessione e quello di
    // sistema se non c'e'.
    host('rin-macbook', 'rin-locale', { utenti: ['rin-locale', 'rin'], durata: 96, quando: now - 3 * ORA }),
    // Indietro di undici giorni, e con tre tool che mancano sul portatile.
    host('sam-macbook', 'sam', { immagine: IMG.vecchia, creata: creata(13), toolMancanti: 3, toolMancantiNomi: ['jq', 'gh', 'uv'], durata: 212, quando: now - 2 * ORA }),
    // Versione NON dichiarata e un avvio finito a meta'.
    host('noa-macbook', 'noa', { immagine: 'sconosciuta', creata: null, esito: 'parziale', toolMancanti: 0, durata: 168, quando: now - 5 * ORA }),
    host('kim-macbook', 'kim', { durata: 131, quando: now - 2.5 * ORA }),
    host('lee-macbook', 'lee', { durata: 69, quando: now - 26 * ORA }),
    host('eli-macbook', 'eli', { immagine: IMG.media, creata: creata(4), durata: 88, quando: now - 7 * ORA }),
  ]
  // Gli ultimi avvii per macchina, dal piu' recente: esito, passo e immagine, come li manda l'avvio.
  const avvio = (fa, dentro = {}) => ({ quando: now - fa, lato: 'host', esito: 'ok', passo: null, classe: null, primaRiga: null, immagine: IMG.nuova, creata: creata(2), durata: 80, ...dentro })
  const storia = {
    'alex-macbook': [avvio(40 * 60_000, { durata: 74 }), avvio(40 * 60_000 - 60_000, { lato: 'container', durata: 41, creata: null }), avvio(2 * GIORNO, { immagine: IMG.media, creata: creata(4) })],
    'rin-macbook': [avvio(3 * ORA, { durata: 96 }), avvio(27 * ORA, { durata: 102 }), avvio(3 * GIORNO, { immagine: IMG.media, creata: creata(4) })],
    'sam-macbook': [
      avvio(2 * ORA, { immagine: IMG.vecchia, creata: creata(13), durata: 212 }),
      avvio(26 * ORA, { immagine: IMG.vecchia, creata: creata(13), esito: 'ko', passo: 'tool', classe: 'tool-mancante', primaRiga: 'command not found: uv', durata: 64 }),
      avvio(6 * GIORNO, { immagine: IMG.vecchia, creata: creata(13), durata: 198 }),
    ],
    'noa-macbook': [
      avvio(5 * ORA, { immagine: 'sconosciuta', creata: null, esito: 'parziale', passo: 'migrazioni', classe: 'porta-occupata', primaRiga: 'porta 5432 gia in uso', durata: 168 }),
      avvio(2 * GIORNO, { immagine: IMG.media, creata: creata(4), durata: 140 }),
    ],
    'kim-macbook': [avvio(2.5 * ORA, { durata: 131 }), avvio(30 * ORA, { durata: 125 }), avvio(4 * GIORNO, { immagine: IMG.media, creata: creata(4), durata: 119 })],
    'lee-macbook': [avvio(26 * ORA, { durata: 69 }), avvio(5 * GIORNO, { immagine: IMG.media, creata: creata(4), durata: 71 })],
    'eli-macbook': [avvio(7 * ORA, { immagine: IMG.media, creata: creata(4), durata: 88 }), avvio(3 * GIORNO, { immagine: IMG.media, creata: creata(4), durata: 90 })],
  }
  return { macchine, storia, IMG }
}

// Sette giorni di righe di salute, una ogni 15 minuti per Mac. Le curve: un ciclo giornaliero (il
// carico sale di giorno) piu' una tendenza per chi peggiora.
export function demoSaluteEventi(now = Date.now()) {
  const PASSO = 15 * 60_000
  const righe = Math.floor((7 * GIORNO) / PASSO)
  const fine = Math.floor(now / PASSO) * PASSO
  const eventi = []
  const ciclo = (t) => (1 + Math.sin(((t / ORA) % 24) / 24 * 2 * Math.PI - Math.PI / 2)) / 2 // 0 di notte, 1 di pomeriggio
  const r1 = (x) => Math.round(x * 10) / 10
  const uso = (dentro = {}) => ({
    ultimo_up: new Date(now - 3 * ORA).toISOString(),
    ultimo_update: new Date(now - 2 * GIORNO).toISOString(),
    doctor: { quando: new Date(now - 20 * ORA).toISOString(), ok: 24, warn: 1, ko: 0, falliti: [] },
    opt_out: [],
    bloccati_mac: 0,
    sul_mac: 0,
    ...dentro,
  })
  const MAC = [
    {
      macchina: 'kim-macbook',
      utente: 'kim',
      riga: (t, i, k) => {
        const peggio = k // 0 una settimana fa, 1 adesso
        const c = ciclo(t)
        // Il contatore OOM dal boot della VM: uno tre giorni fa, due l'altro ieri, tre nelle ultime 24 ore.
        const oom = [now - 4 * GIORNO, now - 2.2 * GIORNO, now - 20 * ORA, now - 9 * ORA, now - 2 * ORA].filter((x) => x <= t).length + (t >= now - 2.2 * GIORNO ? 1 : 0)
        return {
          mac: { ram_gb: 24, swap_usata_mb: Math.round((3 + 9.5 * peggio) * 1024 * (0.7 + 0.3 * c)), memoria_libera_pct: Math.round(30 - 22 * peggio) },
          docker: { desktop: 'Docker Engine - Community', motore: 'colima', vm_mem_gb: 11.7, vm_mem_impostata_gb: 12, vm_mem_obiettivo_gb: 14, vm_cpu: 4 },
          vm: { oom_kill: oom, mem_disponibile_gb: r1(Math.max(0.4, 6.5 - 4.4 * peggio - 1.6 * c)) },
          app_mb: { backend: Math.round(1500 + 2242 * peggio), frontend: Math.round(900 + 247 * peggio), altro: 600 },
          container: {
            uccisi_per_memoria: t >= now - 20 * ORA ? ['dev'] : [],
            uso: {
              dev: { mem_mb: Math.round(3000 + 1957 * peggio), cpu_pct: Math.round(60 + 241 * c * (0.6 + 0.4 * peggio)) },
              postgres: { mem_mb: 1320, cpu_pct: Math.round(8 + 30 * c) },
              gateway: { mem_mb: 240, cpu_pct: 3 },
              redis: { mem_mb: 96, cpu_pct: 1 },
            },
          },
          uso: uso({ doctor: { quando: new Date(now - 30 * ORA).toISOString(), ok: 23, warn: 2, ko: 0, falliti: [] } }),
        }
      },
    },
    {
      macchina: 'sam-macbook',
      utente: 'sam',
      riga: (t, i, k) => sano(t, { ram: 16, vm: 8, obiettivo: 8, base: 3.4, swap: 1.2, cpu: 120, k, dentro: { uso: uso({ ultimo_update: new Date(now - 13 * GIORNO).toISOString() }) } }),
    },
    {
      macchina: 'noa-macbook',
      utente: 'noa',
      riga: (t, i, k) =>
        sano(t, {
          ram: 32,
          vm: 12,
          obiettivo: 12,
          base: 6,
          swap: 0.8,
          cpu: 140,
          k,
          dentro: {
            uso: uso({
              opt_out: ['DEVENV_NO_MIGRATE', 'DEVENV_NO_GUARDS'],
              doctor: { quando: new Date(now - 6 * ORA).toISOString(), ok: 21, warn: 1, ko: 2, falliti: ['porte-libere', 'login-segreti'] },
            }),
          },
        }),
    },
    {
      macchina: 'rin-macbook',
      utente: 'rin',
      // Ogni riga dice quanti comandi dalla riga prima: nelle ultime 24 ore ne passano una ventina.
      riga: (t, i, k) =>
        sano(t, {
          ram: 32,
          vm: 12,
          obiettivo: 12,
          base: 6.8,
          swap: 0.4,
          cpu: 160,
          k,
          dentro: { uso: uso({ bloccati_mac: t >= now - GIORNO && i % 6 === 0 ? 2 : 0, sul_mac: t >= now - GIORNO && i % 11 === 0 ? 1 : 0 }) },
        }),
    },
    { macchina: 'alex-macbook', utente: 'alex', riga: (t, i, k) => sano(t, { ram: 32, vm: 12, obiettivo: 12, base: 7.2, swap: 0.3, cpu: 110, k }) },
    { macchina: 'lee-macbook', utente: 'lee', riga: (t, i, k) => sano(t, { ram: 18, vm: 9, obiettivo: 9, base: 4.6, swap: 0.9, cpu: 90, k }) },
    { macchina: 'eli-macbook', utente: 'eli', riga: (t, i, k) => sano(t, { ram: 24, vm: 10, obiettivo: 10, base: 5.4, swap: 0.6, cpu: 130, k }) },
  ]
  function sano(t, { ram, vm, obiettivo, base, swap, cpu, dentro = {} }) {
    const c = ciclo(t)
    return {
      mac: { ram_gb: ram, swap_usata_mb: Math.round(swap * 1024 * (0.6 + 0.4 * c)), memoria_libera_pct: Math.round(40 - 15 * c) },
      docker: { desktop: 'Docker Desktop 4.48.0', motore: 'docker-desktop', vm_mem_gb: vm - 0.3, vm_mem_impostata_gb: vm, vm_mem_obiettivo_gb: obiettivo, vm_cpu: 6 },
      vm: { oom_kill: 0, mem_disponibile_gb: r1(base - 1.8 * c) },
      app_mb: { backend: Math.round(900 + 300 * c), frontend: Math.round(700 + 200 * c), altro: 500 },
      container: {
        uccisi_per_memoria: [],
        uso: {
          dev: { mem_mb: Math.round(2200 + 600 * c), cpu_pct: Math.round(20 + cpu * c) },
          postgres: { mem_mb: 980, cpu_pct: Math.round(4 + 12 * c) },
          gateway: { mem_mb: 210, cpu_pct: 2 },
          redis: { mem_mb: 80, cpu_pct: 1 },
        },
      },
      uso: uso(),
      ...dentro,
    }
  }
  for (const m of MAC) {
    for (let i = righe - 1; i >= 0; i--) {
      const t = fine - i * PASSO
      // lee ha chiuso il Mac ieri: dall'ultimo avvio in poi niente righe, e le curve si fermano li'.
      if (m.macchina === 'lee-macbook' && t > now - 25 * ORA) continue
      const k = (righe - 1 - i) / (righe - 1)
      eventi.push({ timestamp: t, message: JSON.stringify({ utente: m.utente, macchina: m.macchina, lato: 'host', salute: m.riga(t, i, k) }) })
    }
  }
  return eventi.sort((a, b) => b.timestamp - a.timestamp)
}

export function demoFlotta(now = Date.now()) {
  const { macchine, storia } = demoMacchineDevEnv(now)
  const heartbeat = {
    giorni: 7,
    attesa: null,
    macchine,
    versioni: [],
    conToolMancanti: macchine.filter((m) => m.toolMancanti > 0).length,
    storia,
    classiNuove: [],
    bloccate: [],
  }
  const salute = settimanaDiSalute(demoSaluteEventi(now), { adesso: now, ore: 24, giorni: 7 })
  return {
    ...componiFlotta(
      { heartbeat, salute },
      { adesso: now, soglie: SOGLIE_DEV_ENV, comandi: { aggiorna: './dev-env update', doctor: './dev-env doctor', salute: null, dentro: './dev-env shell' } },
    ),
    sshCommand: 'tsh ssh dev@{macchina}',
    auditNodeUrl: 'https://teleport.example.com/web/audit?node={macchina}',
    auditUserUrl: 'https://teleport.example.com/web/audit?user={utente}',
    webUrl: 'https://teleport.example.com/web',
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

// Lo storico delle 24 ore: le build sono quelle di demoDeploys, gli allarmi e gli eventi ECS sono
// inventati qui nella forma in cui li restituisce AWS, e il tutto passa per lo stesso componiStorico
// del server. Così la demo mostra un guasto «rotto 12 minuti dopo il deploy» vero, calcolato.
export function demoHistory(ore = 24) {
  const ora = Date.now()
  const m = 60_000
  const voce = (nome, agoMin, da, a) => ({
    AlarmName: nome,
    HistoryItemType: 'StateUpdate',
    Timestamp: new Date(ora - agoMin * m).toISOString(),
    HistoryData: JSON.stringify({ oldState: { stateValue: da }, newState: { stateValue: a } }),
  })
  const dep = demoDeploys()
  const metriche = (errOggi, errIeri, p95Oggi, p95Ieri) => ({
    oggi: { lambda: { errori: errOggi, invocazioni: 4200, p95ms: 820 }, alb: { errori: errOggi * 2, richieste: 18000, p95ms: p95Oggi } },
    ieri: { lambda: { errori: errIeri, invocazioni: 4100, p95ms: 790 }, alb: { errori: errIeri * 2, richieste: 17500, p95ms: p95Ieri } },
  })
  const perConto = {
    prod: {
      builds: dep.prod.builds,
      // L'hotfix del backend è di 45 minuti fa: l'allarme scatta 12 minuti dopo e rientra.
      voci: [voce('backend-5xx-alto', 33, 'OK', 'ALARM'), voce('backend-5xx-alto', 20, 'ALARM', 'OK'), voce('coda-pagamenti-lenta', 900, 'OK', 'ALARM'), voce('coda-pagamenti-lenta', 870, 'ALARM', 'OK')],
      meta: {
        'backend-5xx-alto': { Dimensions: [{ Name: 'ServiceName', Value: 'demo-production-backend' }] },
        'coda-pagamenti-lenta': { Dimensions: [{ Name: 'FunctionName', Value: 'demo-production-billing-worker' }] },
      },
      ecs: [{ ts: new Date(ora - 12 * m).toISOString(), message: '(service demo-production-backend) has reached a steady state.', servizio: 'backend' }],
      metriche: metriche(21, 9, 340, 310),
      errori: [],
    },
    staging: {
      builds: dep.staging.builds,
      voci: [voce('search-api-target-unhealthy', 24, 'OK', 'ALARM')],
      meta: { 'search-api-target-unhealthy': { Dimensions: [{ Name: 'ServiceName', Value: 'demo-staging-search-api' }] } },
      ecs: [{ ts: new Date(ora - 25 * m).toISOString(), message: '(service demo-staging-search-api) was unable to place a task because no container instance met all of its requirements.', servizio: 'search-api' }],
      metriche: metriche(3, 4, 410, 450),
      errori: [],
    },
    cloudflare: { provider: 'cloudflare', builds: dep.cloudflare.builds, errori: [] },
  }
  return componiStorico({ perConto, ora, ore })
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
      { ts: now - 3600000, eventName: 'PutScalingPolicy', user: 'alex', source: 'application-autoscaling.amazonaws.com', errorCode: 'AccessDenied' },
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
      run({ id: 'c3d9f1a07e5b4c2d8a6f0b1e9d7c5a34', startedAt: now - 5820 * min, endedAt: now - 5765 * min, running: false, exitCode: 0, outcome: 'ok', stream: 'cron/crawler/c3d9f1a07e5b4c2d8a6f0b1e9d7c5a34' }),
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
    crons: [crawler, digest, legacy].map(withSummary).map((c) => ({ ...c, durataTipicaMs: durataTipica(c.runs) })),
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

// La MAPPA degli accessi in demo: stesso cast delle altre viste, nomi di team e di permessi generici.
// ⚠️ L'immagine demo e' PUBBLICA: qui dentro non entra un nome vero di team, ruolo o account.
// Le tre cose che la demo deve far vedere, perche' sono quelle che si sbagliano a leggere:
//   · una persona con i due lati agganciati (Teleport + portale) e una con uno solo;
//   · un team dei soli repository, che su Teleport non concede niente;
//   · una persona senza login recenti, che ha comunque i permessi del portale.
export function demoMappaAccessi() {
  const now = Date.now()
  const ruoli = {
    'access-db-read': ['db-orders-ro', 'db-app-ro'],
    'access-db-write': ['db-app-rw'],
    'access-logs': ['logs-staging-read', 'logs-prod-read'],
    'app-repos': [],
  }
  const persone = [
    {
      persona: 'alex',
      organizzazione: 'acme',
      ultimoLogin: now - 4 * 60_000,
      teams: ['access-db-read', 'access-logs'],
      teamsNoti: true,
      ruoli: ['db-app-ro', 'db-orders-ro', 'logs-prod-read', 'logs-staging-read'],
      teamsSenzaRuoli: [],
      ssoUtente: 'alex',
      gruppiSso: ['developers'],
      permessi: [
        { account: 'Staging', permissionSet: 'dev-logs-readonly', via: 'developers' },
        { account: 'Production', permissionSet: 'dev-logs-readonly', via: 'developers' },
      ],
    },
    {
      persona: 'kim',
      organizzazione: 'acme',
      ultimoLogin: now - 3 * 3600_000,
      teams: ['access-db-write', 'app-repos'],
      teamsNoti: true,
      ruoli: ['db-app-rw'],
      // Il team dei repository non porta ruoli: la riga lo dice invece di sembrare una mappa rotta.
      teamsSenzaRuoli: ['app-repos'],
      ssoUtente: null,
      gruppiSso: [],
      permessi: [],
    },
    {
      persona: 'rin',
      organizzazione: null,
      ultimoLogin: null,
      teams: [],
      teamsNoti: false,
      ruoli: [],
      teamsSenzaRuoli: [],
      ssoUtente: 'rin',
      gruppiSso: ['data'],
      permessi: [{ account: 'Production', permissionSet: 'data-readonly', via: 'data' }],
      soloSso: true,
    },
  ]
  return {
    configurato: true,
    ore: 168,
    webUrl: 'https://teleport.example.com/web',
    persone,
    teams: Object.entries(ruoli).map(([team, r]) => ({
      team,
      ruoli: r,
      membri: persone.filter((p) => p.teams.includes(team)).map((p) => p.persona),
      soloRepo: r.length === 0,
    })),
    gruppiSso: [
      { gruppo: 'developers', membri: ['alex'], permessi: [{ account: 'Staging', permissionSet: 'dev-logs-readonly' }, { account: 'Production', permissionSet: 'dev-logs-readonly' }] },
      { gruppo: 'data', membri: ['rin'], permessi: [{ account: 'Production', permissionSet: 'data-readonly' }] },
    ],
    fonti: {
      teleport: { ok: true, persone: 2 },
      ruoli: { ok: true, teams: 4, generato: new Date(now - 26 * 3600_000).toISOString(), scritto: now - 26 * 3600_000 },
      sso: { ok: true, permissionSets: 3 },
    },
  }
}

// Spesa giornaliera demo: 30 giorni fino a oggi, stessa forma di `meta/spesa.js`. Valori calcolati da
// una funzione del giorno e non casuali, cosi' la stessa demo mostra lo stesso grafico a ogni apertura.
export function demoSpesaGiornaliera(now = new Date()) {
  const perAccount = { prod: 140, staging: 38, management: 22 }
  const out = {}
  for (const [k, base] of Object.entries(perAccount)) {
    const righe = Array.from({ length: 30 }, (_, i) => {
      const g = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29 + i))
      const giorno = g.toISOString().slice(0, 10)
      // Oggi e' parziale: e' il caso vero, e senza la colonna di oggi sembrerebbe un giorno qualunque.
      const quota = i === 29 ? now.getUTCHours() / 24 || 0.4 : 1
      const onda = 1 + 0.18 * Math.sin(i / 2.3) + (g.getUTCDay() % 6 === 0 ? -0.25 : 0)
      return { TimePeriod: { Start: giorno }, Total: { UnblendedCost: { Amount: String(base * onda * quota) } } }
    })
    const label = { prod: 'Production', staging: 'Staging', management: 'Management (payer)' }[k]
    out[k] = { label, currency: 'USD', ...aggregaGiorni(righe, righe[29].TimePeriod.Start) }
  }
  return out
}
