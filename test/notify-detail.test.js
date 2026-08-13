import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slackMessage, causeLabel, cleanDetail } from '../server/notify/slack.js'
import { snapshot } from '../server/notify/diff.js'
import { unhealthyList } from '../server/runtime/alb.js'
import { makeT } from '../server/i18n.js'

// Due righe vere lette in canale il 13/08/2026:
//   acme-staging-alb-int [STAGING] ATTENZIONE · esecuzione — 6/7 target sani
//   webhook-dispatch   [STAGING] ATTENZIONE · esecuzione — 28 chiamate · 10.7% errori · p95 751ms
// Nessuna delle due dice cosa è rotto: «esecuzione» è il nome del MODULO che fa il controllo (lo stesso
// per ventidue tipi di risorsa), e il dettaglio è la frase scritta per la card, dove accanto ci sono le
// metriche e il pannello dei task. In chat non c'è niente accanto.
const t = makeT('it')

test('causa: la parola è quella della RISORSA, non del modulo che la controlla', () => {
  assert.equal(causeLabel({ cause: 'runtime', type: 'alb' }, t), 'target')
  assert.equal(causeLabel({ cause: 'runtime', type: 'acm' }, t), 'certificato')
  assert.equal(causeLabel({ cause: 'runtime', type: 's3' }, t), 'esposizione')
  // Una Lambda a schedule è un cron: lo dice `outcome`, che esiste solo sui cron. Una on-demand no.
  assert.equal(causeLabel({ cause: 'runtime', type: 'lambda', outcome: 'missed' }, t), 'cron')
  assert.equal(causeLabel({ cause: 'runtime', type: 'lambda' }, t), 'funzione')
  assert.equal(causeLabel({ cause: 'runtime', type: 'ecs-scheduled', outcome: 'failed' }, t), 'cron')
})

test('causa: tipo assente o non mappato → «esecuzione», non la chiave grezza', () => {
  assert.equal(causeLabel({ cause: 'runtime', type: null }, t), 'esecuzione')
  assert.equal(causeLabel({ cause: 'runtime', type: 'quantum-db' }, t), 'esecuzione')
  // Gli altri check non c'entrano col tipo di risorsa: restano la loro parola.
  assert.equal(causeLabel({ cause: 'secrets', type: 'ecs' }, t), 'secret')
  assert.equal(causeLabel({ cause: null, type: 'ecs' }, t), '')
})

// Le chiavi costruite a runtime (`notify.cause.type.*`, `state.*`) non le vede il controllo di parità
// dei dizionari, che scansiona solo i `t('chiave')` scritti a mano: se manca la riga EN, in inglese
// esce la chiave grezza e nessun test se ne accorge.
test('parità it/en anche sulle chiavi composte a runtime', () => {
  const en = makeT('en')
  for (const k of ['notify.cause.type.alb', 'notify.cause.type.lambda.cron', 'notify.cause.type.acm', 'state.inprogress', 'state.active_impaired', 'state.available']) {
    assert.notEqual(en(k), k, `manca in EN: ${k}`)
    assert.notEqual(t(k), k, `manca in IT: ${k}`)
  }
})

test('dettaglio: il ⚠ dentro al testo si toglie (l’icona di stato è già la prima cosa della riga)', () => {
  assert.equal(cleanDetail('⚠ nessuna esecuzione (l’ultima attesa 2h fa)'), 'nessuna esecuzione (l’ultima attesa 2h fa)')
  assert.equal(cleanDetail('⚠️ ESPOSTA: nessun login davanti'), 'ESPOSTA: nessun login davanti')
  assert.equal(cleanDetail(null), '')
})

test('dettaglio: tetto di lunghezza, perché sommate le spiegazioni allungano la riga', () => {
  const lungo = 'x'.repeat(400)
  const out = cleanDetail(lungo)
  assert.ok(out.length <= 160, `dettaglio non tagliato: ${out.length}`)
  assert.ok(out.endsWith('…'), 'il taglio si vede')
  assert.equal(cleanDetail('corto'), 'corto', 'chi sta nel tetto non viene toccato')
})

test('dettaglio: `alert` vince su `summary` — la card e la chat non vogliono la stessa frase', () => {
  const svc = {
    name: 'api',
    account: { key: 'stg', label: 'Staging' },
    overall: 'degraded',
    cause: 'drift',
    type: 'lambda',
    checks: { drift: { summary: 'no · memoria 512MB (TF: 1024MB)', alert: 'fuori sync con Terraform: memoria 512MB (TF: 1024MB)' } },
  }
  assert.equal(snapshot([svc])['stg/api'].detail, 'fuori sync con Terraform: memoria 512MB (TF: 1024MB)')
  // Senza `alert` si resta sul summary: i provider che non hanno niente in più da dire non cambiano.
  delete svc.checks.drift.alert
  assert.equal(snapshot([svc])['stg/api'].detail, 'no · memoria 512MB (TF: 1024MB)')
})

test('target fuori: si nominano i primi due e poi «+N», col motivo di AWS', () => {
  const bad = [
    { id: 'i-aaa', reason: 'Target.FailedHealthChecks' },
    { id: 'i-bbb', reason: 'Target.Timeout' },
    { id: 'i-ccc', reason: 'Target.Timeout' },
  ]
  assert.equal(unhealthyList(bad, t), 'i-aaa (Target.FailedHealthChecks), i-bbb (Target.Timeout), +1')
  assert.equal(unhealthyList([{ id: 'i-aaa', reason: null }], t), 'i-aaa', 'senza motivo resta il solo id')
})

test('la riga intera: causa e dettaglio non ripetono la stessa parola', () => {
  const { text } = slackMessage(
    [
      {
        kind: 'alert',
        name: 'acme-staging-alb-int',
        account: 'Staging',
        from: 'up',
        to: 'degraded',
        cause: 'runtime',
        type: 'alb',
        detail: t('alb.unhealthy', { n: 1, total: 7, list: 'i-0abc (Target.FailedHealthChecks)' }),
      },
    ],
    { t },
  )
  assert.match(text, /ATTENZIONE · target — 1 target su 7 non sano: i-0abc \(Target\.FailedHealthChecks\)/)
  assert.ok(!text.includes('esecuzione'), 'la vecchia parola non torna')
  assert.ok(!text.startsWith('<!channel>'), 'staging non suona la sirena')
})

test('la riga intera: il dettaglio che ripete l’esito non si scrive due volte', () => {
  const { text } = slackMessage(
    [{ kind: 'recovery', name: 'acme-prod-cdn', account: 'Production', from: 'degraded', to: 'disabled', type: 'cloudfront', detail: t('cf.disabled') }],
    { t },
  )
  assert.match(text, /spenta di proposito/)
  assert.equal(text.match(/spenta di proposito/g).length, 1, 'una volta, non due')
})

test('la riga intera: la soglia che ha fatto scattare l’allarme sta nel messaggio', () => {
  const detail =
    t('lambda.alerterr', { err: 3, n: 28, p: '10.7', window: '60m' }) +
    ' · ' +
    t('lambda.p95', { d: '751ms' }) +
    t('rule.fires', { regola: t('lambda.regola') })
  const { text } = slackMessage(
    [{ kind: 'alert', name: 'webhook-dispatch', account: 'Staging', from: 'up', to: 'degraded', cause: 'runtime', type: 'lambda', detail }],
    { t },
  )
  assert.match(text, /3 errori su 28 chiamate \(10\.7%\) in 60m/, 'errori in valore assoluto e finestra')
  assert.match(text, /scatta a: un errore o un throttle qualsiasi/, 'e la regola')
})
