import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffStates, snapshot, stateClass, serviceKey } from '../server/notify/diff.js'
import { slackMessage } from '../server/notify/slack.js'
import { runOnce, watchConfig } from '../server/notify/watch.js'

// Il notificatore vive o muore su una cosa: mandare i messaggi GIUSTI. Un watchdog che grida per
// ogni sfarfallio si silenzia dopo due giorni, e uno che tace su un guasto non serve a niente.

const svc = (name, account, overall, cause = null, detail = null) => ({
  name,
  account: { key: account.toLowerCase(), label: account },
  overall,
  cause,
  checks: cause ? { [cause]: { summary: detail } } : {},
})
const stato = (servizi) => ({ services: servizi })
const conferma = { confirmations: 2 }

// --- il confine che conta ---
test('stateClass: problema, non-problema, e "non lo so"', () => {
  assert.equal(stateClass('down'), 'problem')
  assert.equal(stateClass('degraded'), 'problem')
  assert.equal(stateClass('up'), 'quiet')
  assert.equal(stateClass('idle'), 'quiet')
  assert.equal(stateClass('disabled'), 'quiet')
  assert.equal(stateClass('unknown'), 'unknown')
  assert.equal(stateClass(undefined), 'unknown')
})

// --- primo giro: prende nota, non annuncia ---
test('primo giro (o dopo un riavvio): nessuna notifica, solo la fotografia', () => {
  const now = snapshot([svc('cron-a', 'Production', 'down', 'runtime', 'nessuna esecuzione'), svc('api', 'Staging', 'up')])
  const { transitions, next } = diffStates(null, now, conferma)
  assert.deepEqual(transitions, [], 'un riavvio non deve rovesciare in chat lo stato del mondo')
  assert.equal(next.services['production/cron-a'].confirmed, 'down')
  assert.equal(next.services['staging/api'].confirmed, 'up')
})

test('servizio NUOVO in una flotta già nota: si prende nota senza annunciare', () => {
  const prev = stato({ 'staging/api': { confirmed: 'up' } })
  const now = snapshot([svc('api', 'Staging', 'up'), svc('nuovo', 'Staging', 'down', 'runtime')])
  const { transitions, next } = diffStates(prev, now, conferma)
  assert.deepEqual(transitions, [])
  assert.equal(next.services['staging/nuovo'].confirmed, 'down')
})

// --- debounce: una transizione conta solo se regge ---
test('debounce: un solo giro rosso NON notifica (throttle CloudWatch di 30s)', () => {
  const prev = stato({ 'staging/api': { confirmed: 'up' } })
  const { transitions, next } = diffStates(prev, snapshot([svc('api', 'Staging', 'down', 'runtime')]), conferma)
  assert.deepEqual(transitions, [])
  assert.deepEqual(next.services['staging/api'], { confirmed: 'up', pending: { overall: 'down', count: 1 } })
})

test('debounce: due giri rossi di fila notificano', () => {
  const prev = stato({ 'staging/api': { confirmed: 'up', pending: { overall: 'down', count: 1 } } })
  const { transitions, next } = diffStates(prev, snapshot([svc('api', 'Staging', 'down', 'runtime', 'p95 oltre il timeout')]), conferma)
  assert.equal(transitions.length, 1)
  assert.equal(transitions[0].kind, 'alert')
  assert.equal(transitions[0].from, 'up')
  assert.equal(transitions[0].to, 'down')
  assert.equal(transitions[0].detail, 'p95 oltre il timeout')
  assert.equal(next.services['staging/api'].confirmed, 'down')
  assert.equal(next.services['staging/api'].pending, null)
})

test('debounce: lo sfarfallio (giù, su, giù) non annuncia niente', () => {
  let s = stato({ 'staging/api': { confirmed: 'up' } })
  for (const overall of ['down', 'up', 'down', 'up']) {
    const r = diffStates(s, snapshot([svc('api', 'Staging', overall, 'runtime')]), conferma)
    assert.deepEqual(r.transitions, [], `sfarfallio su ${overall}`)
    s = r.next
  }
  assert.equal(s.services['staging/api'].confirmed, 'up')
})

// --- anti-ripetizione ---
test('un rosso che RESTA rosso non si ripete a ogni giro', () => {
  let s = stato({ 'production/cron': { confirmed: 'up', pending: { overall: 'down', count: 1 } } })
  const primo = diffStates(s, snapshot([svc('cron', 'Production', 'down', 'runtime')]), conferma)
  assert.equal(primo.transitions.length, 1, 'la prima volta si annuncia')
  s = primo.next
  for (let i = 0; i < 5; i++) {
    const r = diffStates(s, snapshot([svc('cron', 'Production', 'down', 'runtime')]), conferma)
    assert.deepEqual(r.transitions, [], 'e poi mai più, finché non cambia')
    s = r.next
  }
})

test('il ritorno alla normalità si annuncia (recovery)', () => {
  const prev = stato({ 'production/cron': { confirmed: 'down', pending: { overall: 'up', count: 1 } } })
  const { transitions } = diffStates(prev, snapshot([svc('cron', 'Production', 'up')]), conferma)
  assert.equal(transitions.length, 1)
  assert.equal(transitions[0].kind, 'recovery')
  assert.equal(transitions[0].to, 'up')
})

// --- cosa NON è un evento ---
test('up → idle non è un guasto (un modello Bedrock che nessuno chiama)', () => {
  const prev = stato({ 'production/claude': { confirmed: 'up', pending: { overall: 'idle', count: 1 } } })
  const { transitions, next } = diffStates(prev, snapshot([svc('claude', 'Production', 'idle')]), conferma)
  assert.deepEqual(transitions, [], 'quiet → quiet: nessuna notizia')
  assert.equal(next.services['production/claude'].confirmed, 'idle', 'ma lo stato noto si aggiorna')
})

test('up → unknown non notifica: "non lo so" è un problema del controllo, non del servizio', () => {
  const prev = stato({ 'staging/api': { confirmed: 'up', pending: { overall: 'unknown', count: 1 } } })
  const { transitions } = diffStates(prev, snapshot([svc('api', 'Staging', 'unknown')]), conferma)
  assert.deepEqual(transitions, [])
})

test('unknown → down notifica comunque (il controllo torna a vedere, e vede un guasto)', () => {
  const prev = stato({ 'staging/api': { confirmed: 'unknown', pending: { overall: 'down', count: 1 } } })
  const { transitions } = diffStates(prev, snapshot([svc('api', 'Staging', 'down', 'runtime')]), conferma)
  assert.deepEqual(transitions, [], 'da "non lo so" non si può dire cosa è cambiato')
})

test('cron spento di proposito: down → disabled è un rientro, non un allarme', () => {
  const prev = stato({ 'staging/cron': { confirmed: 'down', pending: { overall: 'disabled', count: 1 } } })
  const { transitions } = diffStates(prev, snapshot([svc('cron', 'Staging', 'disabled')]), conferma)
  assert.equal(transitions[0].kind, 'recovery')
})

test('servizio spartito: se non lo vedo più, non è un guasto', () => {
  const prev = stato({ 'staging/vecchio': { confirmed: 'up' }, 'staging/api': { confirmed: 'up' } })
  const { transitions, next } = diffStates(prev, snapshot([svc('api', 'Staging', 'up')]), conferma)
  assert.deepEqual(transitions, [])
  assert.ok(!('staging/vecchio' in next.services), 'ed esce dallo stato senza rumore')
})

test('serviceKey distingue lo stesso nome in due account (backend esiste in staging E prod)', () => {
  assert.notEqual(serviceKey(svc('backend', 'Staging', 'up')), serviceKey(svc('backend', 'Production', 'up')))
})

// --- il messaggio ---
test('messaggio: cosa, dove, perché, e il link per continuare', () => {
  const t = (k) => ({ 'notify.status.down': 'GIÙ', 'notify.cause.runtime': 'esecuzione', 'notify.open': 'Apri Dadaguard' })[k] ?? k
  const { text } = slackMessage(
    [{ kind: 'alert', name: 'cron-refresh-bi-mvs', account: 'Production', from: 'up', to: 'down', cause: 'runtime', detail: '⚠ ultima esecuzione FALLITA' }],
    { url: 'https://dadaguard.example', t },
  )
  assert.match(text, /cron-refresh-bi-mvs/)
  assert.match(text, /Production/)
  assert.match(text, /GIÙ/)
  assert.match(text, /esecuzione/)
  assert.match(text, /ultima esecuzione FALLITA/)
  assert.match(text, /dadaguard\.example/)
  assert.match(text, /^<!channel>/, 'un guasto in produzione chiama il canale')
})

test('messaggio: niente <!channel> per staging né per un rientro', () => {
  const t = (k) => k
  const stg = slackMessage([{ kind: 'alert', name: 'api', account: 'Staging', to: 'down', cause: 'runtime' }], { t })
  const ok = slackMessage([{ kind: 'recovery', name: 'cron', account: 'Production', to: 'up' }], { t })
  assert.ok(!stg.text.includes('<!channel>'), 'staging non sveglia nessuno')
  assert.ok(!ok.text.includes('<!channel>'), 'un rientro non sveglia nessuno')
  assert.match(ok.text, /🟢/)
})

// --- il giro completo, con le dipendenze finte ---
test('runOnce: se Slack fallisce lo stato NON si salva (la transizione si riprova)', async () => {
  const prev = stato({ 'production/cron': { confirmed: 'up', pending: { overall: 'down', count: 1 } } })
  let salvato = null
  const res = await runOnce(
    { ...watchConfig({}), webhook: 'https://hooks.example/x', confirmations: 2 },
    {
      getStatus: async () => ({ services: [svc('cron', 'Production', 'down', 'runtime', 'giù')] }),
      loadState: async () => prev,
      saveState: async (_f, s) => {
        salvato = s
      },
      postSlack: async () => false, // Slack irraggiungibile
    },
  )
  assert.equal(res.transitions.length, 1)
  assert.equal(res.sent, false)
  assert.equal(salvato, null, 'senza salvare, al giro dopo si riprova')
})

test('runOnce: senza webhook non manda niente ma tiene lo stato aggiornato', async () => {
  let salvato = null
  const res = await runOnce(
    { ...watchConfig({}), webhook: null, confirmations: 1 },
    {
      getStatus: async () => ({ services: [svc('api', 'Staging', 'down', 'runtime', 'giù')] }),
      loadState: async () => stato({ 'staging/api': { confirmed: 'up' } }),
      saveState: async (_f, s) => {
        salvato = s
      },
      postSlack: async () => {
        throw new Error('non deve essere chiamato')
      },
    },
  )
  assert.equal(res.transitions.length, 1)
  assert.equal(salvato.services['staging/api'].confirmed, 'down')
})

test('watchConfig: valori di default sensati e limiti minimi', () => {
  const d = watchConfig({})
  assert.equal(d.intervalMs, 300_000)
  assert.equal(d.confirmations, 2)
  assert.equal(d.webhook, null)
  // un intervallo assurdo non deve martellare AWS ogni secondo
  assert.equal(watchConfig({ DADAGUARD_WATCH_INTERVAL: '1' }).intervalMs, 30_000)
  assert.equal(watchConfig({ DADAGUARD_WATCH_CONFIRM: '0' }).confirmations, 2)
})
