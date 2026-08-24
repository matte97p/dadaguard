import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffStates, snapshot, stateClass, serviceKey } from '../server/notify/diff.js'
import { slackMessage, envTag } from '../server/notify/slack.js'
import { runOnce, watchConfig } from '../server/notify/watch.js'
import { makeT } from '../server/i18n.js'

// Il notificatore vive o muore su una cosa: mandare i messaggi GIUSTI. Un watchdog che grida per
// ogni sfarfallio si silenzia dopo due giorni, e uno che tace su un guasto non serve a niente.

// `extra` finisce dentro al check colpevole: serve ai campi che il check dichiara oltre al testo
// (oggi `provisional`), senza toccare le chiamate che quel campo non lo usano.
const svc = (name, account, overall, cause = null, detail = null, extra = {}) => ({
  name,
  account: { key: account.toLowerCase(), label: account },
  overall,
  cause,
  checks: cause ? { [cause]: { summary: detail, ...extra } } : {},
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

// `alerted: true` = l'allarme è stato davvero mandato (lo scrive watch.js dopo l'invio). È la
// precondizione del rientro: senza, il verde sarebbe orfano — vedi il test più sotto.
test('il ritorno alla normalità si annuncia (recovery)', () => {
  const prev = stato({ 'production/cron': { confirmed: 'down', alerted: true, pending: { overall: 'up', count: 1 } } })
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
  const prev = stato({ 'staging/cron': { confirmed: 'down', alerted: true, pending: { overall: 'disabled', count: 1 } } })
  const { transitions } = diffStates(prev, snapshot([svc('cron', 'Staging', 'disabled')]), conferma)
  assert.equal(transitions[0].kind, 'recovery')
})

// --- il verde orfano: un rientro senza il rosso che lo precede ---
// Visto in produzione su Bedrock: rosso su claude-haiku alle 10:19, verde su claude-opus-5 alle 11:01,
// e per opus-5 nessun rosso era mai stato mandato. I modelli Bedrock sono AUTOSCOPERTI: compaiono nella
// watchlist appena qualcuno li chiama, e se alla prima apparizione hanno già un errore vengono
// registrati come rotti in silenzio (per design). Senza il gate, il loro rientro parla di un allarme
// che nessuno ha visto.
test('chiave nuova nata già rotta: quando rientra NON manda un verde orfano', () => {
  // giro 1: il modello compare per la prima volta, già degraded → si prende nota, niente allarme
  const primo = diffStates(stato({ 'production/api': { confirmed: 'up' } }), snapshot([svc('api', 'Production', 'up'), svc('claude-opus-5', 'Production', 'degraded', 'runtime')]), conferma)
  assert.deepEqual(primo.transitions, [], 'la comparsa non si annuncia')
  assert.equal(primo.next.services['production/claude-opus-5'].alerted, false)

  // giro 2 e 3: l'errore esce dalla finestra, il modello torna up (2 letture = confermato)
  let s = primo.next
  for (const giro of [1, 2]) {
    const r = diffStates(s, snapshot([svc('api', 'Production', 'up'), svc('claude-opus-5', 'Production', 'up')]), conferma)
    assert.deepEqual(r.transitions, [], `giro ${giro}: nessun "tornato OK" per un allarme mai mandato`)
    s = r.next
  }
  assert.equal(s.services['production/claude-opus-5'].confirmed, 'up', 'ma lo stato noto si aggiorna')
})

test('allarme taciuto dal routing: nemmeno il suo rientro parla', () => {
  // `alerted` assente = nessun invio è mai avvenuto per questa chiave
  const prev = stato({ 'production/cron': { confirmed: 'down', pending: { overall: 'up', count: 1 } } })
  const { transitions } = diffStates(prev, snapshot([svc('cron', 'Production', 'up')]), conferma)
  assert.deepEqual(transitions, [], 'simmetria: se non ho detto che si è rotto, non dico che è a posto')
})

// --- le due gravità dentro al rosso (regola 5) --------------------------------------------------
test('il flag alerted sopravvive a un alleggerimento (down → degraded → up)', () => {
  // Regressione: `down → degraded` NON chiude l'allarme, passa solo dal ramo che riscrive lo stato.
  // Se lì si perdesse `alerted`, il rientro VERO verrebbe soppresso e resteremmo con un rosso appeso.
  let s = stato({ 'production/api': { confirmed: 'down', alerted: true, route: 'main', pending: { overall: 'degraded', count: 1 } } })
  const dentro = diffStates(s, snapshot([svc('api', 'Production', 'degraded', 'runtime')]), conferma)
  assert.equal(dentro.transitions.length, 1, 'scendere di gravità è una notizia')
  assert.equal(dentro.transitions[0].kind, 'improvement', 'ma non è un rientro: siamo ancora nel rosso')
  assert.equal(dentro.next.services['production/api'].alerted, true, 'il flag resta')
  assert.equal(dentro.next.services['production/api'].route, 'main', 'e anche la destinazione')

  s = dentro.next
  s.services['production/api'].pending = { overall: 'up', count: 1 }
  const rientro = diffStates(s, snapshot([svc('api', 'Production', 'up')]), conferma)
  assert.equal(rientro.transitions.length, 1, 'il rientro vero si annuncia')
  assert.equal(rientro.transitions[0].kind, 'recovery')
})

test('peggiorare dentro al rosso (degraded → down) è un allarme, non un aggiornamento muto', () => {
  // Prima passava in silenzio: chi aveva letto l'avviso non sapeva che nel frattempo era diventato
  // un guasto conclamato, e la differenza fra "da guardare" e "sta succedendo adesso" si perdeva.
  const s = stato({ 'production/api': { confirmed: 'degraded', alerted: true, route: 'main', pending: { overall: 'down', count: 1 } } })
  const { transitions } = diffStates(s, snapshot([svc('api', 'Production', 'down', 'runtime')]), conferma)
  assert.equal(transitions.length, 1)
  assert.equal(transitions[0].kind, 'alert', 'stessa sirena di un rosso nuovo')
})

test('alleggerimento di un allarme mai annunciato: silenzio, come per il rientro orfano', () => {
  const s = stato({ 'production/api': { confirmed: 'down', pending: { overall: 'degraded', count: 1 } } })
  const { transitions } = diffStates(s, snapshot([svc('api', 'Production', 'degraded', 'runtime')]), conferma)
  assert.deepEqual(transitions, [], 'non si alleggerisce in chat un allarme che in chat non c-è mai stato')
})

test('messaggio: un alleggerimento si legge come tale, e non chiama il canale', () => {
  const msg = slackMessage([{ kind: 'improvement', name: 'claude-opus-5', account: 'Production', to: 'degraded', from: 'down', detail: 'probabile rientro' }], { t: makeT('it') })
  assert.ok(!msg.text.includes('<!channel>'), 'non è un allarme nuovo: niente sirena')
  assert.ok(msg.text.includes('IN RIENTRO'), 'e si distingue da un ATTENZIONE appena aperto')
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
// La forma è quella che il team legge già in #aws-deploy e #aws-cron-test: emoji shortcode, nome in
// backtick, ambiente in MAIUSCOLO tra quadre, esito a parole, dettaglio dopo "—", fatti separati da
// "·". Questi test la inchiodano: un terzo dialetto costringerebbe a imparare due grammatiche.
test('messaggio: la grammatica di casa (shortcode, backtick, [AMBIENTE], — dettaglio)', () => {
  const t = (k) => ({ 'notify.status.down': 'GIÙ', 'notify.cause.runtime': 'esecuzione', 'notify.open': 'stato su Dadaguard' })[k] ?? k
  const { text } = slackMessage(
    [{ kind: 'alert', name: 'cron-refresh-bi-mvs', account: 'Production', to: 'down', cause: 'runtime', detail: 'mai partito' }],
    { url: 'https://dadaguard.example', t },
  )
  assert.match(text, /:red_circle:/, 'emoji come shortcode, non unicode')
  assert.match(text, /`cron-refresh-bi-mvs`/, 'il soggetto in backtick')
  assert.match(text, /\[PROD\]/, "l'ambiente in maiuscolo tra quadre")
  assert.match(text, /GIÙ · esecuzione — mai partito/, 'esito · causa — dettaglio, sulla stessa riga')
  assert.match(text, / · <https:\/\/dadaguard\.example\|stato su Dadaguard>$/, 'il link chiude la riga come nei deploy')
  assert.ok(!text.includes('🔴'), 'niente emoji unicode')
  assert.ok(!text.includes('\n> '), 'niente citazione a capo')
})

test('envTag: PROD e STAGING come li scrivono cron e deploy', () => {
  assert.equal(envTag('production'), ' [PROD]')
  assert.equal(envTag('Production'), ' [PROD]')
  assert.equal(envTag('staging'), ' [STAGING]')
  assert.equal(envTag('security'), ' [SECURITY]') // gli altri: la propria chiave, in maiuscolo
  assert.equal(envTag(''), '')
  assert.equal(envTag(undefined), '')
})

test('messaggio: cosa, dove, perché, e il link per continuare', () => {
  const t = (k) => ({ 'notify.status.down': 'GIÙ', 'notify.cause.runtime': 'esecuzione', 'notify.open': 'Apri Dadaguard' })[k] ?? k
  const { text } = slackMessage(
    [{ kind: 'alert', name: 'cron-refresh-bi-mvs', account: 'Production', from: 'up', to: 'down', cause: 'runtime', detail: '⚠ ultima esecuzione FALLITA' }],
    { url: 'https://dadaguard.example', t },
  )
  assert.match(text, /cron-refresh-bi-mvs/)
  assert.match(text, /\[PROD\]/) // l'ambiente si scrive come nei cron e nei deploy
  assert.match(text, /GIÙ/)
  assert.match(text, /esecuzione/)
  assert.match(text, /ultima esecuzione FALLITA/)
  assert.match(text, /dadaguard\.example/)
  assert.match(text, /^<!channel>/, 'un guasto in produzione chiama il canale')
})

// --- allarme PROVVISORIO: si annuncia, non chiama ----------------------------------------------
// Uno sforamento visto dalla sola finestra corta porta già scritto «non è ancora una finestra da 60m»:
// chiamare il canale contraddice la frase che il messaggio stesso trasporta. Il caso vero, dal vivo:
// tre 503 in un quarto d'ora scarico, che sull'ora non sono niente e si richiudono da soli.
test('il flag `provisional` del check colpevole arriva fino alla transizione', () => {
  const prev = stato({ 'production/claude-opus-5': { confirmed: 'up', pending: { overall: 'degraded', count: 1 } } })
  const now = snapshot([
    svc('claude-opus-5', 'Production', 'degraded', 'runtime', 'sopra soglia solo negli ultimi 15m', { provisional: true }),
  ])
  const { transitions } = diffStates(prev, now, conferma)
  assert.equal(transitions.length, 1)
  assert.equal(transitions[0].kind, 'alert', 'resta un allarme: cambia la sirena, non lo stato né l instradamento')
  assert.equal(transitions[0].provisional, true)
})

test('un allarme che il check non dichiara provvisorio non lo diventa per conto suo', () => {
  const prev = stato({ 'production/api': { confirmed: 'up', pending: { overall: 'down', count: 1 } } })
  const { transitions } = diffStates(prev, snapshot([svc('api', 'Production', 'down', 'runtime', 'giù')]), conferma)
  assert.equal(transitions[0].provisional, false, 'il default è la sirena: tacere si chiede, non si eredita')
})

test('messaggio: un allarme provvisorio in produzione arriva, ma non chiama il canale', () => {
  const { text } = slackMessage(
    [
      {
        kind: 'alert',
        name: 'claude-opus-5',
        account: 'Production',
        from: 'up',
        to: 'degraded',
        cause: 'runtime',
        detail: '3 err. server (5xx) · sopra soglia solo negli ultimi 15m: non è ancora una finestra da 60m',
        provisional: true,
      },
    ],
    { t: makeT('it') },
  )
  assert.ok(!text.includes('<!channel>'), 'non si strappa nessuno dal lavoro per uno sforamento non confermato')
  assert.match(text, /:warning:/, 'ma il messaggio arriva lo stesso, col suo pallino')
  assert.match(text, /claude-opus-5/)
  assert.match(text, /non è ancora una finestra da 60m/, 'e porta la frase che dice perché è provvisorio')
})

test('messaggio: la conferma dalla finestra lunga (degraded → down) chiama il canale', () => {
  // È la metà che rende accettabile il silenzio all'ingresso: se il guasto è vero, la salita suona.
  const { text } = slackMessage(
    [{ kind: 'alert', name: 'claude-opus-5', account: 'Production', from: 'degraded', to: 'down', cause: 'runtime' }],
    { t: makeT('it') },
  )
  assert.match(text, /^<!channel>/)
})

test('messaggio: niente <!channel> per staging né per un rientro', () => {
  const t = (k) => k
  const stg = slackMessage([{ kind: 'alert', name: 'api', account: 'Staging', to: 'down', cause: 'runtime' }], { t })
  const ok = slackMessage([{ kind: 'recovery', name: 'cron', account: 'Production', to: 'up' }], { t })
  assert.ok(!stg.text.includes('<!channel>'), 'staging non sveglia nessuno')
  assert.ok(!ok.text.includes('<!channel>'), 'un rientro non sveglia nessuno')
  assert.match(ok.text, /:white_check_mark:/)
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

// --- INSTRADAMENTO: cosa si manda, dove, e cosa NON si manda -------------------------------------
// La regola parte da cosa parla già: un cron il pacchetto cron condiviso che crasha lo scrive da sé (con la query e il
// privilegio, meglio di quanto potrebbe dirlo Dadaguard). Ridirlo è duplicare, e due canali che
// dicono la stessa cosa insegnano a ignorarli entrambi. Resta il buco che nessuno può coprire
// dall'interno: il job che NON è mai partito.
import { routeOf, splitByRoute } from '../server/notify/route.js'

const tr = (over) => ({ kind: 'alert', key: 'prod/x', name: 'x', account: 'Production', from: 'up', to: 'down', ...over })

test('instradamento: un cron CADUTO non si manda (lo scrive già il job)', () => {
  assert.equal(routeOf(tr({ type: 'lambda', outcome: 'failed' })), null)
  assert.equal(routeOf(tr({ type: 'ecs-scheduled', outcome: 'failed' })), null)
})

test('instradamento: un cron MAI PARTITO va nel canale dei cron (nessuno può dirlo dall’interno)', () => {
  assert.equal(routeOf(tr({ type: 'lambda', outcome: 'missed' })), 'cron')
  assert.equal(routeOf(tr({ type: 'ecs-scheduled', outcome: 'missed' })), 'cron')
})

test('instradamento: tutto ciò che non è un cron va nella destinazione principale', () => {
  assert.equal(routeOf(tr({ type: 'ecs' })), 'main') // task a 0/N, secret mancante, drift…
  assert.equal(routeOf(tr({ type: 'rds' })), 'main') // backup vecchio
  assert.equal(routeOf(tr({ type: 'bedrock' })), 'main') // 5xx / throttle
  assert.equal(routeOf(tr({ type: 'cloudflare-worker' })), 'main') // errori a runtime
  assert.equal(routeOf(tr({ type: 'acm' })), 'main') // certificato in scadenza
})

test('instradamento: una lambda ON-DEMAND non è un cron (nessun outcome) → principale', () => {
  assert.equal(routeOf(tr({ type: 'lambda', outcome: null })), 'main')
})

test('instradamento: si può riaccendere il cron caduto se lo si vuole comunque', () => {
  assert.equal(routeOf(tr({ type: 'lambda', outcome: 'failed' }), { notifyCronFailed: true }), 'main')
})

test('instradamento: il RIENTRO torna dove l’allarme è stato aperto', () => {
  const rientro = { kind: 'recovery', key: 'prod/cron', name: 'cron', to: 'up', type: 'lambda', outcome: 'ok' }
  const g = splitByRoute([rientro], { routeMemory: { 'prod/cron': 'cron' } })
  assert.deepEqual(g.cron, [rientro], 'chiude il ciclo nel canale dove era stato aperto')
  assert.deepEqual(g.main, [])
})

test('instradamento: senza memoria il rientro segue la regola normale', () => {
  const rientro = { kind: 'recovery', key: 'stg/api', name: 'api', to: 'up', type: 'ecs' }
  const g = splitByRoute([rientro], { routeMemory: {} })
  assert.deepEqual(g.main, [rientro])
})

test('instradamento: divide un giro misto e dice cosa ha taciuto', () => {
  const g = splitByRoute([
    tr({ key: 'p/cron-caduto', type: 'lambda', outcome: 'failed' }),
    tr({ key: 'p/cron-fermo', type: 'ecs-scheduled', outcome: 'missed' }),
    tr({ key: 's/chat', type: 'ecs' }),
  ])
  assert.deepEqual(g.cron.map((x) => x.key), ['p/cron-fermo'])
  assert.deepEqual(g.main.map((x) => x.key), ['s/chat'])
  assert.deepEqual(g.skipped.map((x) => x.key), ['p/cron-caduto'])
})

test('runOnce: il cron mai partito va al webhook dei cron, il resto al principale', async () => {
  const inviati = []
  const svcCron = { name: 'cron', account: { key: 'prod', label: 'Production' }, overall: 'down', cause: 'runtime', type: 'lambda', checks: { runtime: { summary: 'mai partita', outcome: 'missed' } } }
  const svcEcs = { name: 'chat', account: { key: 'stg', label: 'Staging' }, overall: 'down', cause: 'secrets', type: 'ecs', checks: { secrets: { summary: '1 secret mancante' } } }
  await runOnce(
    { ...watchConfig({}), webhook: 'https://hook/main', webhookCron: 'https://hook/cron', confirmations: 1 },
    {
      getStatus: async () => ({ services: [svcCron, svcEcs] }),
      loadState: async () => ({ services: { 'prod/cron': { confirmed: 'up' }, 'stg/chat': { confirmed: 'up' } } }),
      saveState: async () => {},
      postSlack: async (hook, payload) => {
        inviati.push({ hook, testo: payload.text })
        return true
      },
    },
  )
  assert.equal(inviati.length, 2, 'due destinazioni, due messaggi')
  const cron = inviati.find((x) => x.hook.endsWith('/cron'))
  const main = inviati.find((x) => x.hook.endsWith('/main'))
  assert.match(cron.testo, /cron/)
  assert.match(main.testo, /chat/)
  assert.ok(!main.testo.includes('mai partita'), 'niente mescolanza fra le due destinazioni')
})

test('runOnce: senza webhook dedicato, il cron mai partito finisce nel principale', async () => {
  const inviati = []
  const svc = { name: 'cron', account: { key: 'prod', label: 'Production' }, overall: 'down', cause: 'runtime', type: 'ecs-scheduled', checks: { runtime: { summary: 'mai partita', outcome: 'missed' } } }
  await runOnce(
    { ...watchConfig({}), webhook: 'https://hook/main', webhookCron: null, confirmations: 1 },
    {
      getStatus: async () => ({ services: [svc] }),
      loadState: async () => ({ services: { 'prod/cron': { confirmed: 'up' } } }),
      saveState: async () => {},
      postSlack: async (hook, payload) => inviati.push({ hook, testo: payload.text }) && true,
    },
  )
  assert.equal(inviati.length, 1)
  assert.match(inviati[0].hook, /\/main$/, 'meglio nel posto sbagliato che in nessun posto')
})
