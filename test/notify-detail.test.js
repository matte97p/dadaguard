import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slackMessage, causeLabel, cleanDetail } from '../server/notify/slack.js'
import { snapshot } from '../server/notify/diff.js'
import { unhealthyList } from '../server/runtime/alb.js'
import { makeT, hasKey } from '../server/i18n.js'

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
// dei dizionari, che scansiona solo i `t('chiave')` scritti a mano. E non basta chiamare `t`: `makeT`
// ripiega sull'italiano, quindi una riga EN dimenticata non fa uscire la chiave grezza — fa uscire la
// parola ITALIANA a chi legge in inglese, che nessuna assunzione su `t` può vedere. Si guarda il
// dizionario (`hasKey`), che è l'unica cosa che sa la differenza.
test('parità it/en sulle chiavi composte a runtime (guardando il dizionario, non `t`)', () => {
  const chiavi = [
    'notify.cause.type.alb',
    'notify.cause.type.lambda.cron',
    'notify.cause.type.acm',
    'state.inprogress',
    'state.active_impaired',
    'state.available',
    'state.initializing',
    'state.not-applicable',
    'cf.off',
  ]
  for (const k of chiavi) {
    assert.ok(hasKey('it', k), `manca in IT: ${k}`)
    assert.ok(hasKey('en', k), `manca in EN: ${k}`)
  }
})

test('dettaglio: il ⚠ dentro al testo si toglie (l’icona di stato è già la prima cosa della riga)', () => {
  assert.equal(cleanDetail('⚠ nessuna esecuzione (l’ultima attesa 2h fa)'), 'nessuna esecuzione (l’ultima attesa 2h fa)')
  assert.equal(cleanDetail('⚠️ ESPOSTA: nessun login davanti'), 'ESPOSTA: nessun login davanti')
  assert.equal(cleanDetail(null), '')
})

test('dettaglio: tetto di lunghezza, perché sommate le spiegazioni allungano la riga', () => {
  const out = cleanDetail('x'.repeat(400))
  assert.ok(out.length <= 160, `dettaglio non tagliato: ${out.length}`)
  assert.ok(out.includes('…'), 'il taglio si vede')
  assert.equal(cleanDetail('corto'), 'corto', 'chi sta nel tetto non viene toccato')
})

// Il taglio ovvio — buttare la fine — butterebbe via ESATTAMENTE la frase per cui questa PR esiste: la
// soglia e la conseguenza stanno sempre in coda, i numeri (che da soli non decidono niente) in testa.
test('dettaglio: quando si taglia, la coda con soglia e conseguenza resta', () => {
  const detail =
    'aurora-postgresql · disponibile · 2/6 istanze · fuori prod-db-instance-2 (in riavvio), prod-db-instance-3 (in modifica), +2: meno capacità di lettura · fuori il nodo di SCRITTURA prod-db-instance-1 (in riavvio): scritture a rischio'
  const out = cleanDetail(detail)
  assert.ok(out.length <= 160, `oltre il tetto: ${out.length}`)
  assert.match(out, /scritture a rischio$/, 'la frase più grave sopravvive al taglio')
  assert.match(out, /^aurora-postgresql/, 'e l’inizio dice ancora di chi si parla')

  const lambda = `${'chiamate '.repeat(20)}· scatta a: un errore o un throttle qualsiasi`
  assert.match(cleanDetail(lambda), /scatta a: un errore o un throttle qualsiasi$/, 'vale per la regola come per la conseguenza')
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

// Un servizio ECS con tutti i container su e un target fuori è degradato DAI TARGET: intestare la riga
// «task» punterebbe al segnale che sta bene, ed è il motivo per cui `causeType` batte il tipo.
test('causa: il segnale colpevole batte il tipo della risorsa', () => {
  assert.equal(causeLabel({ cause: 'runtime', type: 'ecs', causeType: 'alb' }, t), 'target')
  assert.equal(causeLabel({ cause: 'runtime', type: 'ecs' }, t), 'task', 'senza indicazione resta il tipo')
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
