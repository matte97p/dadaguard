import { createPrivateKey, sign } from 'node:crypto'
import { log } from '../log.js'

// Lo stato dei TEST di una riga del quadro, letto da GitHub Actions. I test non li vede né ECS né
// CodeBuild: girano prima che la build esista, nel workflow del repository, e il quadro li chiede a
// GitHub con una GitHub App dell'organizzazione (permessi Actions e Metadata in lettura). Niente token
// personali: un token di una persona smette di funzionare quando quella persona se ne va, e vede
// tutto quello che vede lei.
//
// Il percorso, in tre passi, tutti con `fetch` e `node:crypto` (nessuna dipendenza nuova):
//   1. un JWT dell'App (RS256, firmato con la sua chiave privata, vale 10 minuti al massimo)
//   2. con quello, l'installazione dell'App sull'organizzazione e un token d'installazione (vale
//      un'ora: si tiene e si rinnova cinque minuti prima che scada)
//   3. con quello, i run dei repository delle righe del quadro nelle ultime 24 ore
//
// Cosa diventa cosa, per l'ultimo commit spinto su un ramo di rilascio:
//   in coda o in corso                  🧪 test avviati
//   finito con failure, cancelled,      ❌ test falliti
//   timed_out o startup_failure
//   finito con success                  niente: la riga la racconta il deploy che segue
// Contano i run nati da un `push` sui rami di rilascio (`DADAGUARD_GITHUB_RAMI`): le pull request e
// i lanci a mano o a orario non sono un rilascio in arrivo. Contano TUTTI i workflow di quel push, non
// solo quello dei test: nei repository dove test e deploy stanno nello stesso workflow (i job di
// deploy con `needs:` sui test) un filtro per nome li perderebbe tutti, e se il deploy parte la riga
// passa comunque a ⏳ (CodeBuild vince sui test, vedi `conTest`).
//
// Il rate limit è di 5.000 richieste l'ora per installazione. Una lettura ogni `GIRI_PER_GITHUB` giri
// (circa una al minuto) e una richiesta per repository, CONDIZIONALE: l'indirizzo cambia solo una
// volta l'ora (la finestra parte dall'inizio dell'ora), quindi l'`ETag` della risposta di prima vale,
// e un `304 Not Modified` non consuma rate limit.
//
// Configurazione (senza le prime due il quadro funziona come prima, senza stati di test, e lo dice
// una volta nel log):
//   DADAGUARD_GITHUB_APP_ID    l'id dell'App
//   DADAGUARD_GITHUB_APP_KEY   la sua chiave privata: PEM, o il PEM in base64 (com'è spesso salvata)
//   DADAGUARD_GITHUB_ORG       facoltativa: solo i repository di questa organizzazione. Senza, quella
//                              di ogni repository, dall'indirizzo della build
//   DADAGUARD_GITHUB_RAMI      quale ramo è quale ambiente (default `produzione=main,staging=staging`)

const API = 'https://api.github.com'
// Una lettura dei run ogni tanti giri del quadro: i test durano minuti, e con 15 secondi fra i giri 4
// vuol dire una al minuto.
export const GIRI_PER_GITHUB = 4
// Dopo un errore che non è il rate limit (chiave sbagliata, App non installata) si riprova di rado.
const GIRI_DOPO_ERRORE = 40
const FINESTRA_MS = 24 * 3_600_000
// Il token d'installazione vale un'ora: si rinnova prima, per non usarlo mentre scade.
const MARGINE_TOKEN_MS = 5 * 60_000
const IN_CORSO = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending'])
const FALLITI = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure'])

export function githubConfig(env = process.env) {
  const appId = String(env.DADAGUARD_GITHUB_APP_ID ?? '').trim()
  const chiave = String(env.DADAGUARD_GITHUB_APP_KEY ?? '').trim()
  if (!appId || !chiave) return null
  const rami = Object.fromEntries(
    String(env.DADAGUARD_GITHUB_RAMI || 'produzione=main,staging=staging')
      .split(',')
      .map((x) => x.split('=').map((y) => y.trim()))
      .filter(([amb, ramo]) => amb && ramo)
      .map(([amb, ramo]) => [ramo, amb]),
  )
  return { appId, chiave, org: String(env.DADAGUARD_GITHUB_ORG ?? '').trim().toLowerCase() || null, rami }
}

// La chiave privata com'è salvata: il PEM, o il PEM in base64 (una riga sola, comoda da tenere in un
// parametro). Puro.
export function chiavePem(valore) {
  const v = String(valore ?? '').trim()
  return v.includes('-----BEGIN') ? v : Buffer.from(v, 'base64').toString('utf8')
}

const b64url = (x) => Buffer.from(x).toString('base64url')

// Il JWT dell'App: RS256, `iss` l'id, `iat` un minuto nel passato (gli orologi non sono mai d'accordo
// al secondo, e un `iat` nel futuro GitHub lo rifiuta), `exp` nove minuti avanti (il massimo è dieci).
// Puro/testabile.
export function jwtApp(appId, chiave, ora = Date.now()) {
  const s = Math.floor(ora / 1000)
  const iss = /^\d+$/.test(String(appId)) ? Number(appId) : String(appId)
  const corpo = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iat: s - 60, exp: s + 540, iss }))}`
  const firma = sign('RSA-SHA256', Buffer.from(corpo), createPrivateKey(chiavePem(chiave)))
  return `${corpo}.${firma.toString('base64url')}`
}

// `https://github.com/org/Repo.git` → `{ owner: 'org', repo: 'Repo' }`; `null` se non è GitHub. Puro.
export function repoDaUrl(url) {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url ?? ''))
  return m ? { owner: m[1], repo: m[2] } : null
}
const chiaveRepo = (r) => `${r.owner}/${r.repo}`.toLowerCase()

// I repository da guardare: quelli delle build delle righe del quadro (applicazioni e IaC), di tutti
// gli ambienti. Le immagini condivise e i componenti esterni non hanno una build nostra. Puro.
export function repoDelQuadro(q, { org = null } = {}) {
  const visti = new Map()
  for (const qa of Object.values(q ?? {}))
    for (const r of [...(qa?.app ?? []), ...(qa?.infra ? [qa.infra] : [])]) {
      const x = repoDaUrl(r.repo)
      if (x && (!org || x.owner.toLowerCase() === org)) visti.set(chiaveRepo(x), x)
    }
  return [...visti.values()]
}

// Lo stato dei test di ogni repository e ambiente, dai suoi run: `ambiente|owner/repo` → `{ stato,
// da, url, sha }`. Conta solo l'ULTIMO commit spinto su ogni ramo di rilascio (i run dei commit di
// prima, cancellati da quello nuovo, non dicono niente). Fra i workflow di quel commit, uno in corso
// basta per 🧪; se sono tutti finiti, uno fallito basta per ❌; tutti verdi, niente. Puro/testabile.
export function statoDaRun(perRepo, rami) {
  const out = new Map()
  for (const [chiave, runs] of perRepo) {
    const perRamo = new Map()
    for (const r of runs ?? []) {
      const amb = rami[r.head_branch]
      if (r.event !== 'push' || !amb) continue
      perRamo.set(amb, [...(perRamo.get(amb) ?? []), r])
    }
    for (const [amb, lista] of perRamo) {
      const ultimo = lista.reduce((a, r) => (Date.parse(r.created_at) > Date.parse(a.created_at) ? r : a), lista[0])
      const delCommit = lista.filter((r) => r.head_sha === ultimo.head_sha)
      const inCorso = delCommit.filter((r) => IN_CORSO.has(r.status))
      const falliti = delCommit.filter((r) => r.status === 'completed' && FALLITI.has(r.conclusion))
      const stato = inCorso.length ? 'in_corso' : falliti.length ? 'fallito' : null
      if (!stato) continue
      const da = delCommit.map((r) => r.run_started_at ?? r.created_at).sort()[0]
      out.set(`${amb}|${chiave}`, { stato, da, url: (inCorso[0] ?? falliti[0]).html_url ?? null, sha: ultimo.head_sha })
    }
  }
  return out
}

// Mette lo stato dei test sulle righe del quadro che vengono da quel repository, in quell'ambiente:
// un repository che rilascia due servizi li segna tutti e due. Puro/testabile.
export function applicaTest(q, stati) {
  if (!stati?.size) return q
  for (const [amb, qa] of Object.entries(q ?? {}))
    for (const r of [...(qa?.app ?? []), ...(qa?.infra ? [qa.infra] : [])]) {
      const x = repoDaUrl(r.repo)
      const t = x && stati.get(`${amb}|${chiaveRepo(x)}`)
      if (t) r.test = t
    }
  return q
}

class LimiteGithub extends Error {}

// Il client: tiene installazioni, token, ETag e l'ultimo stato fra un giro e l'altro. `leggi` non
// lancia mai: GitHub che non risponde vuol dire righe senza stato dei test, non un quadro fermo.
// `deps.fetch` per le prove.
export function nuovoGithub(cfg, deps = {}) {
  if (!cfg) return null
  const fetchGh = deps.fetch ?? globalThis.fetch
  const mem = { giro: 0, prossimo: 0, pausaFino: 0, errore: null, installazioni: new Map(), token: new Map(), etag: new Map(), stati: new Map() }

  async function gh(metodo, path, { auth, etag } = {}) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    try {
      const res = await fetchGh(`${API}${path}`, {
        method: metodo,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'dadaguard',
          Authorization: `Bearer ${auth}`,
          ...(etag ? { 'If-None-Match': etag } : {}),
        },
        signal: ctrl.signal,
      })
      if (res.status === 304) return { stato: 304 }
      // Il rate limit esaurito risponde 403 (o 429) con `x-ratelimit-remaining: 0`, o con `retry-after`
      // per il limite secondario: si aspetta fin lì, invece di insistere e allungare la punizione.
      const resta = res.headers.get('x-ratelimit-remaining')
      if ((res.status === 403 || res.status === 429) && (resta === '0' || res.headers.get('retry-after'))) {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000
        const dopo = Number(res.headers.get('retry-after')) * 1000
        const e = new LimiteGithub(`github ${path.split('?')[0]}: rate limit (HTTP ${res.status})`)
        e.fino = reset > 0 ? reset : Date.now() + (dopo > 0 ? dopo : 60_000)
        throw e
      }
      // Solo lo status nel messaggio, mai l'intestazione: lì c'è il token.
      if (!res.ok) throw Object.assign(new Error(`github ${metodo} ${path.split('?')[0]}: HTTP ${res.status}`), { status: res.status })
      return { stato: res.status, json: await res.json(), etag: res.headers.get('etag') }
    } finally {
      clearTimeout(timer)
    }
  }

  // L'installazione dell'App sul proprietario dei repository: un'organizzazione, o in subordine un
  // utente. Non cambia, quindi si chiede una volta.
  async function installazione(owner, ora) {
    const k = owner.toLowerCase()
    if (!mem.installazioni.has(k)) {
      const jwt = jwtApp(cfg.appId, cfg.chiave, ora)
      const r = await gh('GET', `/orgs/${encodeURIComponent(owner)}/installation`, { auth: jwt }).catch((err) =>
        err.status === 404 ? gh('GET', `/users/${encodeURIComponent(owner)}/installation`, { auth: jwt }) : Promise.reject(err),
      )
      mem.installazioni.set(k, r.json.id)
    }
    return mem.installazioni.get(k)
  }

  async function token(owner, ora) {
    const id = await installazione(owner, ora)
    const t = mem.token.get(id)
    if (t && t.scade - MARGINE_TOKEN_MS > ora) return t.valore
    const r = await gh('POST', `/app/installations/${id}/access_tokens`, { auth: jwtApp(cfg.appId, cfg.chiave, ora) })
    mem.token.set(id, { valore: r.json.token, scade: Date.parse(r.json.expires_at) || ora + 3_600_000 })
    return r.json.token
  }

  async function leggiRepo(r, ora) {
    // La finestra parte dall'inizio dell'ora di 24 ore fa: l'indirizzo resta uguale per un'ora, e
    // l'ETag della risposta di prima con lui.
    const da = new Date(Math.floor((ora - FINESTRA_MS) / 3_600_000) * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const path = `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/actions/runs?event=push&per_page=50&created=${encodeURIComponent(`>=${da}`)}`
    const prima = mem.etag.get(path)
    try {
      const res = await gh('GET', path, { auth: await token(r.owner, ora), etag: prima?.etag })
      if (res.stato === 304 && prima) return { path, runs: prima.runs }
      const runs = res.json?.workflow_runs ?? []
      mem.etag.set(path, { etag: res.etag, runs })
      return { path, runs }
    } catch (err) {
      // Un token rifiutato (revocato, App reinstallata) si butta: al giro dopo se ne chiede un altro.
      if (err.status === 401) mem.token.clear()
      throw err
    }
  }

  async function leggi(repos, { ora = Date.now(), ogni = GIRI_PER_GITHUB } = {}) {
    mem.giro++
    if (mem.giro < mem.prossimo || ora < mem.pausaFino || !repos.length) return mem.stati
    try {
      const perRepo = new Map()
      const usati = new Set()
      for (const r of repos) {
        const { path, runs } = await leggiRepo(r, ora)
        usati.add(path)
        perRepo.set(chiaveRepo(r), runs)
      }
      // Le risposte delle finestre passate non servono più.
      for (const path of mem.etag.keys()) if (!usati.has(path)) mem.etag.delete(path)
      mem.stati = statoDaRun(perRepo, cfg.rami)
      if (mem.errore) log.info('quadro: GitHub di nuovo leggibile, tornano gli stati dei test')
      mem.errore = null
      mem.prossimo = mem.giro + ogni
    } catch (err) {
      // Una volta sola nel log finché l'errore resta lo stesso: ogni minuto sarebbero 1.440 righe al
      // giorno per una cosa nota. Lo stato di prima resta: meglio un 🧪 di un minuto fa che nessuno.
      if (mem.errore !== err.message) log.warn('quadro: GitHub non letto, righe senza stato dei test aggiornato', { err: err.message })
      mem.errore = err.message
      if (err instanceof LimiteGithub) mem.pausaFino = err.fino
      else mem.prossimo = mem.giro + GIRI_DOPO_ERRORE
    }
    return mem.stati
  }

  return { leggi, mem, org: cfg.org }
}
