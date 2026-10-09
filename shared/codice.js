// DOVE sta il codice di un cron, e come chiamarlo perché chi legge lo capisca al primo sguardo.
//
// Il nome di uno schedule (`<org>-<env>-email-clienti`) dice come l'infrastruttura chiama il job, non
// che cosa fa né dove si va a guardarlo: `ssm-housekeeper` non dice di quale repository è. Il fatto lo
// porta un tag AWS, `Codice`, messo dall'IaC sulla risorsa che gira (la task definition di un cron ECS,
// la funzione di un cron Lambda, compreso il `-reaper` di un job, che porta il Codice del suo job).
// Due forme, e solo due:
//   · `<repo>/<percorso>` per i repository dell'organizzazione (`acme-crons/email-clienti`,
//     `Backend/cron_aggiornamenti`, `scraper/scripts/canary.py`);
//   · un indirizzo https intero per il codice di altri (un modulo esterno fissato a una versione).
//
// Vive in `shared/` perché lo usano la pagina Cron (web/) e il canvas delle corse in Slack
// (server/notify/corse.js): con due copie la pagina e il canvas chiamerebbero lo stesso cron in due
// modi. Nessun import, come shared/cron.js: lo carica anche il server, e l'immagine copia `shared/`.

const URL_RE = /^https?:\/\//i
// `tree/<ref>/` o `blob/<ref>/` in un indirizzo di GitHub: il ref (un ramo, un tag di versione) dice
// QUALE copia del codice, non DOVE sta, e in un'etichetta è rumore. Resta nel link.
const REF_RE = /\/(?:tree|blob)\/[^/]+(?=\/|$)/

const pulisci = (s) =>
  String(s ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '')

// Il Codice di una risorsa dai suoi tag, nelle due forme in cui AWS li restituisce: la lista
// `[{ key, value }]` di ECS e la mappa `{ Chiave: valore }` di Lambda. Il nome del tag si confronta
// senza badare alle maiuscole: `codice` scritto a mano in un apply non deve sparire in silenzio.
// Vuoto o assente → null (il cron tiene il nome di oggi). Pura/testabile.
export function codiceDaTag(tags) {
  if (!tags) return null
  const coppie = Array.isArray(tags) ? tags.map((t) => [t?.key ?? t?.Key, t?.value ?? t?.Value]) : Object.entries(tags)
  const v = coppie.find(([k]) => String(k ?? '').toLowerCase() === 'codice')?.[1]
  return pulisci(v) || null
}

// L'etichetta da leggere al posto del nome dello schedule. Pura/testabile.
//   `acme-crons/email-clienti`                                   → uguale
//   `https://github.com/altri/modulo/tree/v7.4.0/lambdas/funzioni` → `altri/modulo/lambdas/funzioni`
// Senza `https://github.com/` e senza `tree/<ref>`: quello che resta è proprietario, repository e
// percorso, cioè quello che si cerca. Un indirizzo che non è di GitHub perde solo lo schema.
export function etichettaCodice(codice) {
  const c = pulisci(codice)
  if (!c) return null
  if (!URL_RE.test(c)) return c
  let u
  try {
    u = new URL(c)
  } catch {
    return c
  }
  const host = u.hostname.replace(/^www\./, '')
  const percorso = pulisci(decodeURIComponent(u.pathname).replace(REF_RE, ''))
  if (host === 'github.com') return percorso || host
  return [host, percorso].filter(Boolean).join('/')
}

// Il repository del Codice: il primo segmento di `<repo>/<percorso>`, il secondo di un indirizzo di
// GitHub (dopo il proprietario). Serve alle squadre (server/notify/corse.js), che riconoscono un cron
// anche dal repository del suo sorgente. Pura/testabile.
export function repoDelCodice(codice) {
  const c = pulisci(codice)
  if (!c) return null
  if (!URL_RE.test(c)) return c.split('/')[0] || null
  try {
    const u = new URL(c)
    if (u.hostname.replace(/^www\./, '') !== 'github.com') return null
    return pulisci(u.pathname).split('/')[1] || null
  } catch {
    return null
  }
}

// Il link al codice. Pura/testabile.
//   indirizzo intero   → così com'è, ma solo se è http(s): un tag con `javascript:` dentro non
//                        diventa un link cliccabile su una pagina interna
//   `<repo>/<percorso>` → `https://github.com/<org>/<repo>/tree/<ref>/<percorso>`, SOLO se l'org è
//                        configurata. Il nome dell'organizzazione nel codice non c'è e non ci va
//                        (il repo è pubblico): senza, il percorso si mostra senza link
// `tree` e non `blob` anche per un file: GitHub lo reindirizza da sé, e la stessa forma vale per
// cartelle e file senza dover indovinare quale dei due è.
export function urlCodice(codice, { org = null, ref = 'main' } = {}) {
  const c = pulisci(codice)
  if (!c) return null
  if (URL_RE.test(c)) {
    try {
      return new URL(c).href
    } catch {
      return null
    }
  }
  const o = pulisci(org)
  if (!o) return null
  const [repo, ...resto] = c.split('/').filter(Boolean)
  if (!repo) return null
  const seg = (s) => encodeURIComponent(s)
  const percorso = resto.map(seg).join('/')
  return `https://github.com/${seg(o)}/${seg(repo)}/tree/${seg(pulisci(ref) || 'main')}${percorso ? `/${percorso}` : ''}`
}

// Le etichette di una LISTA di cron, chiave → testo. Pura/testabile.
//
// Due job che lanciano lo stesso script (stesso Codice) avrebbero la stessa etichetta, e una lista con
// due righe uguali non si legge: a quelle si aggiunge ` · <nome breve del job>`. Il confronto è per
// ACCOUNT: lo stesso cron in produzione e in staging ha lo stesso Codice per costruzione, sta in
// sezioni diverse (o con l'account accanto), e allungare tutte e due le righe non direbbe niente.
// Senza Codice l'etichetta è il nome di oggi (`nome`), che dentro un account è già unico.
//   nome   il nome da mostrare senza Codice (la pagina: lo schedule intero; il canvas: quello breve)
//   breve  il nome breve del job, per distinguere due righe col Codice uguale
export function etichetteCron(crons = [], { nome = (c) => c?.name, breve = (c) => c?.name } = {}) {
  const base = new Map()
  const conti = new Map()
  for (const c of crons ?? []) {
    const daCodice = etichettaCodice(c?.codice)
    const testo = daCodice ?? String(nome(c) ?? c?.key ?? '')
    base.set(c?.key, { testo, daCodice: Boolean(daCodice) })
    const k = `${c?.account ?? ''}\u0000${testo}`
    conti.set(k, (conti.get(k) ?? 0) + 1)
  }
  const out = new Map()
  for (const c of crons ?? []) {
    const { testo, daCodice } = base.get(c?.key)
    const doppia = conti.get(`${c?.account ?? ''}\u0000${testo}`) > 1
    out.set(c?.key, doppia && daCodice ? `${testo} · ${breve(c)}` : testo)
  }
  return out
}

export const SUFFISSO_REAPER = '-reaper'

// I REAPER dentro la riga del loro job. Pura/testabile.
//
// Un job lungo ha accanto una Lambda `<job>-reaper` che ferma le sue corse rimaste appese: è una
// parte del job, non un lavoro a sé, e come riga separata raddoppiava la lista con un nome che a chi
// legge non dice niente. Quindi un cron il cui nome breve è `<job>-reaper`, e il cui `<job>` esiste
// nello STESSO account, entra nella riga del job come `reaper` e sparisce dalla lista. Un reaper senza
// job (job spento e tolto, nome diverso) resta una riga sua: piegarlo nel nulla lo nasconderebbe.
// Il job si cerca su tutti i suoi nomi (schedule, famiglia della task definition, funzione), come le
// squadre: lo schedule può chiamarsi diverso dalla risorsa.
// Il reaper che FALLISCE non sparisce: lo stato del job lo conta (`statoCron` in shared/cron.js).
//   breve  nome → nome breve (senza `<org>-<env>-` né `cron-`): lo passa chi lo sa calcolare
export function piegaReaper(crons = [], { breve = (n) => n } = {}) {
  const lista = crons ?? []
  const nomiDi = (c) => [c?.name, c?.family, c?.function].filter(Boolean).map((n) => String(breve(n)))
  const perAccount = new Map()
  for (const c of lista) {
    const a = c?.account ?? ''
    if (!perAccount.has(a)) perAccount.set(a, new Map())
    for (const n of nomiDi(c)) if (!perAccount.get(a).has(n)) perAccount.get(a).set(n, c)
  }
  const reaperDi = new Map() // job.key → reaper
  for (const c of lista) {
    const proprio = nomiDi(c).find((n) => n.endsWith(SUFFISSO_REAPER))
    if (!proprio) continue
    const job = perAccount.get(c?.account ?? '')?.get(proprio.slice(0, -SUFFISSO_REAPER.length))
    // Il job non può essere il reaper stesso, né un altro reaper, e ne tiene uno solo: un secondo
    // reaper sullo stesso job resta una riga, invece di sparire sotto il primo.
    if (!job || job === c || reaperDi.has(job.key) || nomiDi(job).some((n) => n.endsWith(SUFFISSO_REAPER))) continue
    reaperDi.set(job.key, c)
  }
  const piegati = new Set([...reaperDi.values()])
  return lista.filter((c) => !piegati.has(c)).map((c) => (reaperDi.has(c.key) ? { ...c, reaper: reaperDi.get(c.key) } : c))
}
