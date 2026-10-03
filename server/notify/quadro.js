import { log } from '../log.js'
import { ambienteDi, tabellaRilasci } from '../rilasci.js'
import { canonicalActor } from '../util/principal.js'
import { loadConfig } from '../config.js'

// Il QUADRO dei deploy: un messaggio Slack per ambiente, fissato in cima al canale e RISCRITTO a ogni
// giro, invece di due messaggi nuovi per ogni build (`⏳` all'avvio, `🚀`/`🔴` alla fine). Con una
// decina di servizi e due ambienti il canale dei rilasci diventa un registro che nessuno scorre, e la
// domanda vera («cosa gira adesso, e c'è qualcosa di rotto?») si risponde leggendo all'indietro.
// Il quadro la risponde in un colpo d'occhio, come la vista di un'applicazione in un controller GitOps:
// per ogni servizio cosa gira, se un rilascio è in corso, se l'ultimo è fallito, e se staging è avanti.
//
// ⚠️ Un messaggio RISCRITTO non manda notifiche: è il suo pregio (niente rumore) e il suo limite. Un
// fallimento che deve svegliare qualcuno resta un messaggio NUOVO, e non è compito del quadro.
//
// Zero storage, come il resto: il messaggio da riscrivere non si ricorda, si RITROVA fra quelli
// fissati nel canale (scritto da noi, con l'ambiente nei metadati o nel testo). Il filesystem del task
// è effimero, e un `ts` salvato lì si perderebbe a ogni rilascio di Dadaguard stessa, cioè ogni volta
// si fisserebbe un quadro nuovo accanto al vecchio.
//
// Configurazione (tutta opzionale: senza token o canale il quadro non parte e non chiama niente):
//   DADAGUARD_SLACK_BOT_TOKEN    token `xoxb-` di un'app Slack con `chat:write`, `pins:read`,
//                                `pins:write`. Un webhook NON basta: con un webhook non si modifica
//                                un messaggio già mandato, che è tutto il punto
//   DADAGUARD_QUADRO_CANALE      id del canale (`C0123…`), non il nome: le API vogliono l'id
//   DADAGUARD_QUADRO_AMBIENTI    quali ambienti, in ordine (default `produzione,staging`)
//   DADAGUARD_QUADRO_INTERVAL    secondi fra i giri (default 60: un deploy dura ~4 minuti, e a 300 un
//                                rilascio intero passerebbe senza che il quadro lo veda in corso)

const DEFAULT_INTERVAL_S = 60
const EVENTO = 'dadaguard_quadro'
const FALLITI = new Set(['FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED'])
const ETICHETTA = { produzione: 'PROD', staging: 'STAGING' }

export function quadroConfig(env = process.env) {
  const ambienti = (env.DADAGUARD_QUADRO_AMBIENTI || 'produzione,staging')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => ETICHETTA[s])
  return {
    token: env.DADAGUARD_SLACK_BOT_TOKEN || null,
    canale: env.DADAGUARD_QUADRO_CANALE || null,
    ambienti,
    intervalMs: Math.max(30, Number(env.DADAGUARD_QUADRO_INTERVAL) || DEFAULT_INTERVAL_S) * 1000,
    publicUrl: env.DADAGUARD_PUBLIC_URL || null,
  }
}

const tempo = (b) => new Date(b?.startedAt ?? 0).getTime()

// Lo stato di UN servizio in UN ambiente, dalle sue build (più recente prima o in qualsiasi ordine).
//
// Tre stati, e la differenza fra il secondo e il terzo è quella che il canale di oggi non dice:
//   in_corso  l'ultimo tentativo sta girando: si dice la fase e da quanto
//   fallito   l'ultimo tentativo è fallito DOPO l'ultimo riuscito: in produzione gira ancora il commit
//             di prima, ed è quello che si scrive accanto (un `🔴` da solo fa credere il servizio giù)
//   ok        l'ultimo riuscito è anche l'ultimo tentativo
// Un riavvio a mano non cambia il commit: conta come evento più recente, non come rilascio.
// Puro/testabile.
export function statoServizio(builds = []) {
  const ordinate = [...builds].sort((a, b) => tempo(b) - tempo(a))
  const ultima = ordinate[0] ?? null
  const ok = ordinate.find((b) => b.status === 'SUCCEEDED' && b.kind !== 'restart') ?? null
  if (!ultima) return null
  const base = { commit: ok?.commit ?? null, quando: ok?.startedAt ?? null, autore: ok?.author ?? null, build: ok?.number ?? null }
  if (ultima.inProgress || ultima.status === 'IN_PROGRESS')
    return { ...base, stato: 'in_corso', nuovo: ultima.commit ?? null, fase: ultima.phase ?? null, da: ultima.startedAt }
  if (FALLITI.has(ultima.status) && tempo(ultima) >= tempo(ok))
    return {
      ...base,
      stato: 'fallito',
      nuovo: ultima.commit ?? null,
      fase: ultima.failPhase ?? null,
      da: ultima.startedAt,
      log: ultima.logsUrl ?? null,
      // Un riavvio a mano che fallisce non porta un commit: scriverlo come un rilascio fallito farebbe
      // cercare una build che non esiste.
      ...(ultima.kind === 'restart' ? { riavvioFallito: true } : {}),
    }
  if (ultima.kind === 'restart') return { ...base, stato: 'ok', riavvio: { da: ultima.startedAt, chi: ultima.forcedBy ?? null } }
  return { ...base, stato: 'ok' }
}

// Il quadro intero: per ambiente, una riga per servizio, dal payload per-account di `/api/deploys`.
// Lo stesso dato della pagina Deploy, quindi nessuna chiamata AWS in più.
// La colonna «staging avanti» si deduce dalla tabella dei rilasci, che fa già il confronto. Puro.
export function quadro(perAccount = {}) {
  const perAmbiente = { produzione: new Map(), staging: new Map() }
  for (const [chiave, dati] of Object.entries(perAccount)) {
    const amb = ambienteDi(chiave)
    if (!amb || dati?.error) continue
    for (const b of dati?.builds ?? []) {
      // Solo build di deploy e riavvii: le altre azioni a mano (shell nei container, porte dei security
      // group) stanno nello stesso elenco della pagina ma non cambiano cosa gira, e nel quadro
      // diventerebbero «servizi» chiamati come un container o un `sg-…`.
      if (!b.service || b.provider === 'cloudflare' || (b.kind && b.kind !== 'restart')) continue
      const lista = perAmbiente[amb].get(b.service) ?? []
      lista.push(b)
      perAmbiente[amb].set(b.service, lista)
    }
  }
  const disallineati = new Set(tabellaRilasci(perAccount).filter((r) => r.allineato === false).map((r) => r.servizio))
  const out = {}
  for (const [amb, mappa] of Object.entries(perAmbiente)) {
    out[amb] = [...mappa.keys()]
      .sort()
      .map((servizio) => ({ servizio, ...statoServizio(mappa.get(servizio)), stagingAvanti: amb === 'produzione' && disallineati.has(servizio) }))
  }
  return out
}

// «da 3 min», «2 h fa», «ieri»: abbastanza per capire se un rilascio è appeso o vecchio. Puro.
export function eta(iso, ora = Date.now()) {
  if (!iso) return '?'
  const min = Math.max(0, Math.round((ora - new Date(iso).getTime()) / 60_000))
  if (min < 60) return `${min} min`
  const ore = Math.round(min / 60)
  if (ore < 24) return `${ore} h`
  return `${Math.round(ore / 24)} g`
}


// Una riga di testo per servizio. La grammatica è quella del canale dei rilasci: emoji in testa, nome
// in backtick, commit in backtick. Puro/testabile.
// Chi ha rilasciato passa dagli stessi alias della pagina dei rilasci (`people` in config), così la
// stessa persona non compare con due nomi fra la pagina e il canale.
export function rigaServizio(r, ora = Date.now(), persone = null) {
  const nome = `\`${r.servizio}\``
  const commit = r.commit ? `\`${r.commit}\`` : 'nessun commit'
  const avanti = r.stagingAvanti ? ' · ↗︎ staging avanti' : ''
  if (r.stato === 'in_corso')
    return `⏳ ${nome} ${commit} → \`${r.nuovo ?? '?'}\` · in corso${r.fase ? ` (${r.fase})` : ''} da ${eta(r.da, ora)}`
  if (r.stato === 'fallito') {
    const dove = r.log ? `<${r.log}|fallito>` : 'fallito'
    // Senza un riuscito nella finestra non si sa cosa gira: dirlo, invece di «gira ancora» il niente.
    const gira = r.commit ? ` · gira ancora ${commit}` : ' · nessun rilascio riuscito nella finestra'
    if (r.riavvioFallito) return `🔴 ${nome} riavvio ${dove} ${eta(r.da, ora)} fa${gira}${avanti}`
    return `🔴 ${nome} \`${r.nuovo ?? '?'}\` ${dove}${r.fase ? ` al ${r.fase}` : ''} ${eta(r.da, ora)} fa${gira}${avanti}`
  }
  const quando = r.quando ? ` · ${eta(r.quando, ora)} fa` : ''
  const nomeAutore = canonicalActor(r.autore, persone)
  const autore = nomeAutore ? ` · ${nomeAutore}` : ''
  const riavvio = r.riavvio ? ` · riavviato ${eta(r.riavvio.da, ora)} fa` : ''
  return `✅ ${nome} ${commit}${quando}${autore}${riavvio}${avanti}`
}

// Il testo di ripiego (notifiche, anteprima, lettori di schermo) E il marcatore con cui il messaggio
// si ritrova se Slack non restituisce i metadati: per questo comincia sempre con le stesse parole.
export function intestazione(ambiente) {
  return `Quadro deploy [${ETICHETTA[ambiente] ?? ambiente.toUpperCase()}]`
}

// Le righe in sezioni da al più 2900 caratteri: Slack ne accetta 3000 per blocco di testo e
// rifiuterebbe l'intero messaggio, non solo la riga in più.
function aSezioni(righe) {
  const out = []
  let corrente = ''
  for (const r of righe) {
    if (corrente && corrente.length + r.length + 1 > 2900) {
      out.push(corrente)
      corrente = ''
    }
    corrente = corrente ? `${corrente}\n${r}` : r
  }
  if (corrente) out.push(corrente)
  return out
}

// Il messaggio Slack di un ambiente: blocchi più testo di ripiego più metadati. Puro/testabile.
// L'ora sta in fondo e non nel titolo: è la sola cosa che cambia a ogni giro, e chi legge il titolo
// deve vedere lo stato, non un orologio.
export function messaggioQuadro(ambiente, righe = [], { ora = Date.now(), url = null, persone = null } = {}) {
  const inCorso = righe.filter((r) => r.stato === 'in_corso').length
  const falliti = righe.filter((r) => r.stato === 'fallito').length
  const avanti = righe.filter((r) => r.stagingAvanti).length
  const sintesi = [falliti && `🔴 ${falliti} fallit${falliti === 1 ? 'o' : 'i'}`, inCorso && `⏳ ${inCorso} in corso`, avanti && `↗︎ ${avanti} da rilasciare`]
    .filter(Boolean)
    .join(' · ') || '✅ tutto fermo e riuscito'
  const testo = `${intestazione(ambiente)}: ${sintesi}`
  const orario = new Date(ora).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })
  const piede = [`aggiornato alle ${orario}`, url && `<${url}/deploys|dettaglio su Dadaguard>`].filter(Boolean).join(' · ')
  const corpo = righe.length ? aSezioni(righe.map((r) => rigaServizio(r, ora, persone))) : ['nessun deploy trovato']
  return {
    text: testo,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${testo}*` } },
      { type: 'divider' },
      ...corpo.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } })),
      { type: 'context', elements: [{ type: 'mrkdwn', text: piede }] },
    ],
    metadata: { event_type: EVENTO, event_payload: { ambiente } },
  }
}

// Il link che apre il messaggio nel Block Kit Builder di Slack: l'anteprima di come apparirà, senza
// mandare niente a nessuno. Serve a provare il quadro prima di dargli un canale. Puro.
export function anteprimaUrl(msg) {
  return `https://app.slack.com/block-kit-builder/#${encodeURIComponent(JSON.stringify({ blocks: msg.blocks }))}`
}

// ── La parte che parla con Slack ──────────────────────────────────────────────────────────────────

// Una chiamata alla Web API, senza SDK (come `postSlack`). Slack risponde 200 anche sugli errori, col
// motivo in `error`: si controlla `ok`, non lo status HTTP.
export async function chiamaSlack(metodo, corpo, token, { timeoutMs = 5000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const get = metodo === 'pins.list' || metodo === 'auth.test'
    const qs = get ? `?${new URLSearchParams(corpo ?? {})}` : ''
    const res = await fetch(`https://slack.com/api/${metodo}${qs}`, {
      method: get ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(get ? {} : { 'Content-Type': 'application/json; charset=utf-8' }) },
      body: get ? undefined : JSON.stringify(corpo),
      signal: ctrl.signal,
    })
    const json = await res.json()
    if (!json.ok) throw new Error(`slack ${metodo}: ${json.error ?? res.status}`)
    return json
  } finally {
    clearTimeout(timer)
  }
}

// Il quadro di un ambiente fra i messaggi fissati: scritto da NOI (stesso bot) e con quell'ambiente
// nei metadati, o in mancanza con l'intestazione nel testo. Il bot conta: un collega che fissa a mano
// un messaggio che comincia uguale non deve vedersi riscrivere il suo. Puro/testabile.
export function trovaFissato(items = [], { botId, ambiente }) {
  const marcatore = intestazione(ambiente)
  const msg = items
    .filter((i) => i.type === 'message' && i.message)
    .map((i) => i.message)
    .find((m) => {
      if (botId && m.bot_id !== botId) return false
      const meta = m.metadata
      if (meta?.event_type === EVENTO) return meta.event_payload?.ambiente === ambiente
      return String(m.text ?? '').startsWith(marcatore)
    })
  return msg?.ts ?? null
}

// Un giro: per ogni ambiente ritrova il quadro e lo riscrive, o lo manda e lo fissa se non c'è.
// `deps` per le prove: `leggiDeploy` (il payload per-account) e `api` (la Web API).
export async function aggiornaQuadri(cfg, deps = {}) {
  const api = deps.api ?? ((m, c) => chiamaSlack(m, c, cfg.token))
  const perAccount = await deps.leggiDeploy()
  const q = quadro(perAccount)
  const ora = deps.ora ?? Date.now()
  const { bot_id: botId } = await api('auth.test', {})
  const { items = [] } = await api('pins.list', { channel: cfg.canale })
  const esiti = []
  for (const ambiente of cfg.ambienti) {
    const msg = messaggioQuadro(ambiente, q[ambiente] ?? [], { ora, url: cfg.publicUrl, persone: deps.persone ?? null })
    const ts = trovaFissato(items, { botId, ambiente })
    if (ts) {
      await api('chat.update', { channel: cfg.canale, ts, ...msg })
      esiti.push({ ambiente, azione: 'riscritto', ts })
    } else {
      const r = await api('chat.postMessage', { channel: cfg.canale, ...msg })
      await api('pins.add', { channel: cfg.canale, timestamp: r.ts })
      esiti.push({ ambiente, azione: 'creato', ts: r.ts })
    }
  }
  return esiti
}

export function startQuadro(leggiDeploy, env = process.env) {
  const cfg = quadroConfig(env)
  if (!cfg.token || !cfg.canale) {
    log.info('quadro: nessun DADAGUARD_SLACK_BOT_TOKEN o DADAGUARD_QUADRO_CANALE, quadro spento')
    return null
  }
  log.info('quadro: attivo', { ogni: `${cfg.intervalMs / 1000}s`, ambienti: cfg.ambienti })
  const tick = () =>
    // `people` si rilegge a ogni giro, come la config del resto: un alias aggiunto vale dal giro dopo.
    aggiornaQuadri(cfg, { leggiDeploy, persone: loadConfig().people ?? null })
      .then((esiti) => log.info('quadro: giro', { esiti: esiti.map((e) => `${e.ambiente}:${e.azione}`) }))
      .catch((err) => log.error('quadro: giro fallito', { err: err.message }))
  tick()
  const timer = setInterval(tick, cfg.intervalMs)
  timer.unref?.()
  return timer
}
