import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSignals, countByLevel, inWindow } from '../web/nowSignals.js'

const NOW = Date.parse('2026-08-08T12:00:00Z')
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString()
// `t` finto: ritorna la chiave, così i test verificano QUALE frase esce, non la traduzione.
const t = (k) => k

test('inWindow: dentro, fuori, e senza data (che si TIENE)', () => {
  const opts = { now: NOW, hours: 24 }
  assert.equal(inWindow(hoursAgo(2), opts), true)
  assert.equal(inWindow(hoursAgo(30), opts), false)
  // un fatto senza data non si nasconde: non sapere QUANDO non è non sapere SE
  assert.equal(inWindow(null, opts), true)
})

test('un servizio giù è crit, uno degradato warn, uno sano non compare', () => {
  const services = [
    { name: 'backend', overall: 'down', cause: 'runtime', checks: { runtime: { summary: '0/2 task' } }, account: { key: 'prod', label: 'Production' } },
    { name: 'worker', overall: 'degraded', cause: 'secrets', checks: { secrets: { summary: '1 secret mancante' } }, account: { key: 'stg', label: 'Staging' } },
    { name: 'web', overall: 'up', account: { key: 'prod', label: 'Production' } },
  ]
  const out = buildSignals({ services, now: NOW, t })
  assert.equal(out.length, 2)
  assert.equal(out[0].level, 'crit')
  assert.equal(out[0].title, 'backend')
  assert.match(out[0].detail, /cause.runtime — 0\/2 task/)
  assert.equal(out[0].to, '/servizi')
  assert.equal(out[1].level, 'warn')
})

test('deploy: si tengono falliti, in corso e azioni a mano; i rilasci auto riusciti NO', () => {
  const deploys = {
    stg: {
      label: 'Staging',
      builds: [
        { id: 'b1', service: 'backend', status: 'SUCCEEDED', trigger: 'auto', startedAt: hoursAgo(1) },
        // Servizio DIVERSO da quello della build riuscita sopra: da quando un fallimento superato da un
        // rilascio successivo non compare più (vedi il test dedicato), tenerlo su `backend` avrebbe
        // provato la supersessione invece di ciò che questo test prova.
        { id: 'b2', service: 'worker', status: 'FAILED', trigger: 'auto', failPhase: 'BUILD', failReason: 'exit 1', startedAt: hoursAgo(2) },
        { id: 'b3', service: 'chat', status: 'IN_PROGRESS', inProgress: true, trigger: 'auto', startedAt: hoursAgo(0.1) },
        { id: 'b4', service: 'web', status: 'SUCCEEDED', trigger: 'hotfix', forcedBy: 'matte97p', startedAt: hoursAgo(3) },
        { id: 'b5', service: 'api', status: 'SUCCEEDED', kind: 'restart', trigger: 'restart', forcedBy: 'alex', startedAt: hoursAgo(4) },
      ],
    },
  }
  const out = buildSignals({ deploys, now: NOW, t })
  const ids = out.map((s) => s.id)
  assert.ok(!ids.includes('dep:b1'), 'un rilascio automatico riuscito non è una notizia')
  assert.equal(out.find((s) => s.id === 'dep:b2').level, 'bad')
  assert.equal(out.find((s) => s.id === 'dep:b3').level, 'info')
  assert.equal(out.find((s) => s.id === 'dep:b4').level, 'warn') // hotfix: fuori dalla CI
  assert.equal(out.find((s) => s.id === 'dep:b5').level, 'info') // riavvio riuscito: da sapere
  assert.equal(out.find((s) => s.id === 'dep:b4').to, '/deploy?service=web')
})

test('un riavvio RESPINTO non si racconta come una build fallita', () => {
  const deploys = {
    prod: {
      label: 'Production',
      builds: [
        { id: 'r1', service: 'garanzia', kind: 'restart', trigger: 'restart', status: 'FAILED', forcedBy: 'alex', failReason: 'AccessDenied', startedAt: hoursAgo(1) },
      ],
    },
  }
  const [s] = buildSignals({ deploys, now: NOW, t })
  assert.equal(s.level, 'bad')
  assert.match(s.detail, /now\.restartDenied/)
  assert.doesNotMatch(s.detail, /deployFailed/)
})

test('deploy fuori finestra: escluso', () => {
  const deploys = { stg: { label: 'Staging', builds: [{ id: 'old', service: 'backend', status: 'FAILED', startedAt: hoursAgo(48) }] } }
  assert.equal(buildSignals({ deploys, now: NOW, hours: 24, t }).length, 0)
  assert.equal(buildSignals({ deploys, now: NOW, hours: 72, t }).length, 1)
})

test('WAF: una zona che ha fermato traffico; una pulita o in errore no', () => {
  const waf = {
    zones: [
      { zone: 'a.com', zoneId: 'z1', blocked: 1743, logged: 20000, rules: [{ blocking: true, paths: ['/api/v1/tenders'] }] },
      { zone: 'b.com', zoneId: 'z2', blocked: 0, logged: 12, rules: [] },
      { zone: 'c.com', zoneId: 'z3', error: 'scope mancante' },
    ],
  }
  const out = buildSignals({ waf, now: NOW, t })
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'waf')
  assert.equal(out[0].accountKey, 'cloudflare')
  assert.match(out[0].detail, /\/api\/v1\/tenders/)
})

test('budget: sforato e "sforerà" compaiono, quelli a posto no', () => {
  const budgets = {
    accounts: {
      mgmt: {
        label: 'Management',
        budgets: [
          { name: 'org', level: 'over', actualPct: 110 },
          { name: 'llms', level: 'willOver', forecastPct: 123 },
          { name: 'stg', level: 'warn', actualPct: 85 },
          { name: 'ok', level: 'ok', actualPct: 20 },
        ],
      },
    },
    anomalies: [],
  }
  const out = buildSignals({ budgets, now: NOW, t })
  assert.deepEqual(
    out.map((s) => [s.title, s.level]),
    [
      ['org', 'bad'],
      ['llms', 'warn'],
    ],
  )
})

test('anomalie: grosse warn, piccole info, già marcate come attese sempre info', () => {
  const budgets = {
    accounts: {},
    anomalies: [
      { id: 'big', service: 'Bedrock', impact: 412, impactPct: 229, start: hoursAgo(6) },
      { id: 'small', service: 'Lambda', impact: 8, impactPct: 449, start: hoursAgo(5) },
      { id: 'known', service: 'S3', impact: 900, impactPct: 300, feedback: 'YES', start: hoursAgo(4) },
    ],
  }
  const byId = Object.fromEntries(buildSignals({ budgets, now: NOW, t }).map((s) => [s.id, s.level]))
  assert.equal(byId['anom:big'], 'warn')
  assert.equal(byId['anom:small'], 'info')
  assert.equal(byId['anom:known'], 'info')
})

test('ordine: per gravità, e a pari gravità gli stati in corso prima degli eventi datati', () => {
  const services = [{ name: 'giù', overall: 'down', account: { key: 'p' } }]
  const deploys = {
    p: {
      builds: [
        { id: 'vecchia', service: 'x', status: 'FAILED', startedAt: hoursAgo(6) },
        { id: 'recente', service: 'y', status: 'FAILED', startedAt: hoursAgo(1) },
      ],
    },
  }
  const budgets = { accounts: { p: { budgets: [{ name: 'sforato', level: 'over' }] } }, anomalies: [] }
  const out = buildSignals({ services, deploys, budgets, now: NOW, t, nameOf: (s) => s.name })
  assert.equal(out[0].title, 'giù') // crit
  // poi i `bad`: il budget (stato, senza data) prima delle build, e fra le build la più recente
  assert.deepEqual(out.slice(1, 4).map((s) => s.title), ['sforato', 'y', 'x'])
})

test('countByLevel: conta solo i livelli noti', () => {
  const n = countByLevel([{ level: 'crit' }, { level: 'warn' }, { level: 'warn' }, { level: 'boh' }])
  assert.deepEqual(n, { crit: 1, bad: 0, warn: 2, info: 0 })
})

test('nessuna fonte: nessun segnale, e non esplode', () => {
  assert.deepEqual(buildSignals(), [])
  assert.deepEqual(buildSignals({ services: null, deploys: null, waf: null, budgets: null }), [])
})

test('un deploy fallito SUPERATO da un rilascio riuscito non compare più', () => {
  const deploys = {
    prod: {
      label: 'Production',
      builds: [
        // il rilascio riuscito è DOPO il fallimento: il problema non morde più adesso
        { id: 'b2', service: 'backend', status: 'SUCCEEDED', startedAt: hoursAgo(1), endedAt: hoursAgo(1) },
        { id: 'b1', service: 'backend', status: 'FAILED', failPhase: 'POST_BUILD', failReason: 'x', startedAt: hoursAgo(3) },
      ],
    },
  }
  const soloDeploy = buildSignals({ services: [], deploys, hours: 24, now: NOW, t }).filter((s) => s.kind === 'deploy')
  assert.deepEqual(soloDeploy, [])
})

test('un deploy fallito NON superato resta, e un fallimento DOPO il successo resta', () => {
  const deploys = {
    prod: {
      label: 'Production',
      builds: [
        { id: 'ok', service: 'backend', status: 'SUCCEEDED', startedAt: hoursAgo(5), endedAt: hoursAgo(5) },
        { id: 'ko', service: 'backend', status: 'FAILED', failPhase: 'BUILD', failReason: 'boom', startedAt: hoursAgo(2) },
        { id: 'altro', service: 'frontend', status: 'FAILED', failPhase: 'BUILD', failReason: 'boom', startedAt: hoursAgo(2) },
      ],
    },
  }
  const ids = buildSignals({ services: [], deploys, hours: 24, now: NOW, t })
    .filter((s) => s.kind === 'deploy')
    .map((s) => s.id)
  assert.deepEqual(ids.sort(), ['dep:altro', 'dep:ko'])
})

test('un riavvio RESPINTO resta anche se poi è passato un rilascio: non è un guasto che si aggiusta', () => {
  const deploys = {
    prod: {
      label: 'Production',
      builds: [
        { id: 'dep', service: 'backend', status: 'SUCCEEDED', startedAt: hoursAgo(1), endedAt: hoursAgo(1) },
        { id: 'rst', service: 'backend', kind: 'restart', status: 'FAILED', forcedBy: 'persona', startedAt: hoursAgo(3) },
      ],
    },
  }
  const kinds = buildSignals({ services: [], deploys, hours: 24, now: NOW, t }).map((s) => s.kind)
  assert.deepEqual(kinds, ['restart'])
})

test('il motivo di una build fallita non trascina dentro tutto lo script del buildspec', () => {
  const muro =
    'COMMAND_EXECUTION_ERROR: Error while executing command: if aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"; then COUNTS=$(aws ecs describe-services) echo "ok" else exit 1 fi . Reason: exit status 1'
  const deploys = {
    prod: { label: 'Production', builds: [{ id: 'b', service: 'backend', status: 'FAILED', failPhase: 'POST_BUILD', failReason: muro, startedAt: hoursAgo(2) }] },
  }
  const sig = buildSignals({ services: [], deploys, hours: 24, now: NOW, t }).find((s) => s.kind === 'deploy')
  assert.ok(sig.detail.includes('exit status 1'), `atteso l'esito nel dettaglio: ${sig.detail}`)
  assert.ok(!sig.detail.includes('describe-services'), `lo script non deve finire nell'elenco: ${sig.detail}`)
  assert.ok(sig.detail.length < 120, `dettaglio troppo lungo (${sig.detail.length})`)
  // ...ma il testo integrale resta disponibile per chi lo vuole (tooltip della riga, pagina Deploy).
  assert.equal(sig.full, muro)
})

test('un riavvio della CI non è un segnale: è il deploy, che ha già la sua riga', () => {
  const deploys = {
    prod: {
      label: 'Production',
      builds: [
        // `update-service` fatto da CodeBuild durante il rilascio: automazione, non una notizia.
        { id: 'ci', service: 'backend', kind: 'restart', status: 'SUCCEEDED', forcedBy: 'backend-codebuild', actorKind: 'ci', startedAt: hoursAgo(1) },
        // La lambda che sincronizza i segreti riavvia i servizi: manutenzione automatica.
        { id: 'svc', service: 'frontend', kind: 'restart', status: 'SUCCEEDED', forcedBy: 'doppler-ssm-sync', actorKind: 'service', startedAt: hoursAgo(2) },
        // Una persona: questa sì.
        { id: 'io', service: 'garanzia', kind: 'restart', status: 'SUCCEEDED', forcedBy: 'persona', actorKind: 'human', startedAt: hoursAgo(3) },
      ],
    },
  }
  const ids = buildSignals({ services: [], deploys, hours: 24, now: NOW, t }).map((s) => s.id)
  assert.deepEqual(ids, ['dep:io'])
})

test('un riavvio RESPINTO resta anche se lo ha tentato la CI: un permesso negato è un fatto', () => {
  const deploys = {
    prod: {
      label: 'Production',
      builds: [{ id: 'ko', service: 'backend', kind: 'restart', status: 'FAILED', forcedBy: 'backend-codebuild', actorKind: 'ci', failReason: 'AccessDenied', startedAt: hoursAgo(1) }],
    },
  }
  assert.equal(buildSignals({ services: [], deploys, hours: 24, now: NOW, t }).length, 1)
})


// L'id di un segnale è la chiave React della sua riga in pagina: due segnali con lo stesso id sono la
// stessa classe di guaio delle righe fantasma nella tabella (uno rientra, la riga rossa dell'altro
// resta appesa sulla pagina che elenca i guasti). Due risorse omonime dello stesso account si
// distinguono solo per l'identità di risorsa.
test('due risorse omonime giù danno due segnali con id DIVERSI', () => {
  const services = [
    { name: 'gateway', overall: 'down', cause: 'runtime', resourceId: 'security|ecs|||gateway', checks: { runtime: { summary: '0/2 task' } }, account: { key: 'security', label: 'Security' } },
    { name: 'gateway', overall: 'degraded', cause: 'runtime', resourceId: 'security|alb||||||arn:elb', checks: { runtime: { summary: '1/2 target sani' } }, account: { key: 'security', label: 'Security' } },
  ]
  const out = buildSignals({ services, now: NOW, t })
  assert.equal(out.length, 2)
  assert.notEqual(out[0].id, out[1].id)
  assert.equal(new Set(out.map((x) => x.id)).size, 2)
})

test('senza identità di risorsa l id resta quello di prima (account e nome)', () => {
  const services = [{ name: 'backend', overall: 'down', cause: 'runtime', checks: { runtime: {} }, account: { key: 'prod', label: 'Production' } }]
  assert.equal(buildSignals({ services, now: NOW, t })[0].id, 'svc:prod:backend')
})

// ── Allarmi che nessun servizio possiede ──────────────────────────────────────────────────────────
// ⚠️ Sono l'unico posto in cui compaiono: la flotta li correla per DIMENSIONE, e un allarme nato da
// un metric filter su un log group non ne ha nessuna. Prima venivano scaricati e buttati via.
const ORFANO = {
  nome: 'audit-sessioni-negate',
  motivo: 'Threshold Crossed: 1 datapoint [2.0] was greater than the threshold (2.0).',
  da: hoursAgo(1),
  account: 'security',
  accountLabel: 'Security',
}

test('un allarme senza servizio diventa un segnale, con il motivo che AWS ha scritto', () => {
  const s = buildSignals({ alarmi: [ORFANO], now: NOW, t })
  assert.equal(s.length, 1)
  assert.equal(s[0].kind, 'alarm')
  assert.equal(s[0].title, 'audit-sessioni-negate')
  assert.match(s[0].detail, /Threshold Crossed/)
  assert.equal(s[0].accountKey, 'security')
})

test('un allarme senza servizio NON porta a una pagina, e non finisce sopra un servizio giu\'', () => {
  // `to` nullo di proposito: non c'e' una vista che ne sappia di piu', e mandare a una pagina che non
  // lo elenca e' peggio che non offrire il link. La riga in pagina non deve essere cliccabile.
  const giu = { overall: 'down', name: 'backend', account: { key: 'prod', label: 'Production' }, checks: {} }
  const s = buildSignals({ services: [giu], alarmi: [ORFANO], now: NOW, t, nameOf: (x) => x.name })
  assert.equal(s[0].kind, 'service', 'un servizio giu resta la prima riga')
  assert.equal(s[1].kind, 'alarm')
  assert.equal(s[1].to, null)
})

test('nessun allarme orfano: nessuna riga, e una fonte assente non spegne le altre', () => {
  assert.deepEqual(buildSignals({ alarmi: null, now: NOW, t }), [])
  assert.deepEqual(buildSignals({ now: NOW, t }), [])
})
