// «Cosa aspetta la produzione?», ogni mattina. La vista dei rilasci (rilasci.js) mette accanto il commit
// dell'ultimo deploy di staging e quello di produzione, e dice «diversi»: non dice QUANTO lavoro c'è nel
// mezzo, da quanto aspetta, di chi è e a quali ticket appartiene. È la domanda che la squadra si faceva
// aprendo a mano un compare su GitHub, o tenendo un ticket di promemoria per ogni cosa chiusa in staging.
//
// Per ogni repository applicativo (quelli che hanno un deploy nell'account di staging, più quelli
// dichiarati a mano), tre segnali:
//   · i commit del ramo di staging che il ramo di produzione non ha (il compare di GitHub): quanti, da
//     quanto aspetta il più vecchio, chi li ha scritti, quali ticket;
//   · «staging non rilasciato»: la punta del ramo di staging non è il commit dell'ultimo deploy di staging;
//   · «produzione non rilasciata»: la punta del ramo di produzione non è il commit dell'ultimo deploy di
//     produzione (il merge c'è, il deploy no: non è partito, o aspetta un'approvazione).
//
// Il messaggio TACE quando non aspetta niente: una sentinella che dice «tutto a posto» ogni giorno smette
// di essere letta. Ma se un dato non si è potuto leggere lo DICE, con una riga sua: un errore di GitHub
// non deve leggersi come «niente da rilasciare».
//
// Configurazione (senza canale o senza token del bot non parte; senza App GitHub nemmeno):
//   DADAGUARD_ATTESA_CANALE     id del canale Slack (`C0…`) dove scrive il bot del quadro
//                               (DADAGUARD_SLACK_BOT_TOKEN, invitato nel canale)
//   DADAGUARD_ATTESA_ORA        ora locale del messaggio, nei giorni feriali (default 8)
//   DADAGUARD_ATTESA_FUSO       fuso dell'ora qui sopra (default Europe/Rome)
//   DADAGUARD_ATTESA_REPO       facoltativa: repository in più, `owner/repo,owner/repo`, per chi non
//                               ha un deploy CodeBuild (un Worker, un sito statico): solo il compare
//   DADAGUARD_ATTESA_ESCLUSI    facoltativa: nomi di repository da non guardare
//   DADAGUARD_ATTESA_TEAM       facoltativa: prefissi dei ticket validi (`ENG,OPS`). Senza, vale ogni
//                               `ABC-123` nel titolo del commit, ma nel nome del ramo (minuscolo per
//                               convenzione) solo questi: `fix/utf-8` non è il ticket UTF-8
//   DADAGUARD_ATTESA_LINEAR_URL facoltativa: prefisso del link ai ticket (`https://linear.app/<ws>/issue/`)
//   DADAGUARD_PUBLIC_URL        il link in fondo al messaggio
//   DADAGUARD_GITHUB_RAMI       quale ramo è quale ambiente (vedi notify/github.js)
import { ambienteDi, ultimoRilascioPerServizio } from './rilasci.js'
import { repoDaUrl } from './notify/github.js'
import { chiamaSlack } from './notify/quadro.js'
import { log } from './log.js'

const GIORNO_MS = 86_400_000
// Oltre una settimana la riga prende il 🔴: è il punto in cui «lo rilasciamo domani» è diventato
// «ce ne siamo dimenticati».
export const VECCHIO_MS = 7 * GIORNO_MS
// Una punta di ramo appena spostata non ha ancora il suo deploy: è in corso, non mancato.
export const DEPLOY_IN_CORSO_MS = 45 * 60_000
// Le PR lette per repository: una per commit. Oltre, i ticket vengono dai soli titoli.
const MAX_PR_PER_REPO = 30
const MAX_AUTORI = 3
const MAX_TICKET = 6
// Il segno con cui il messaggio si riconosce nella cronologia del canale: è quello che impedisce di
// mandarlo due volte nello stesso giorno se il task riparte (il file di stato su ECS non sopravvive).
export const TITOLO = '*Cosa aspetta la produzione*'

const lista = (v) =>
  String(v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

export function attesaConfig(env = process.env) {
  const rami = Object.fromEntries(
    String(env.DADAGUARD_GITHUB_RAMI || 'produzione=main,staging=staging')
      .split(',')
      .map((x) => x.split('=').map((y) => y.trim()))
      .filter(([amb, ramo]) => amb && ramo),
  )
  const ora = Number(env.DADAGUARD_ATTESA_ORA)
  return {
    canale: env.DADAGUARD_ATTESA_CANALE || null,
    botToken: env.DADAGUARD_SLACK_BOT_TOKEN || null,
    ora: Number.isInteger(ora) && ora >= 0 && ora <= 23 ? ora : 8,
    fuso: env.DADAGUARD_ATTESA_FUSO || 'Europe/Rome',
    extra: lista(env.DADAGUARD_ATTESA_REPO).map((x) => repoDaUrl(`https://github.com/${x}`)).filter(Boolean),
    esclusi: new Set(lista(env.DADAGUARD_ATTESA_ESCLUSI).map((x) => x.toLowerCase())),
    team: lista(env.DADAGUARD_ATTESA_TEAM).map((x) => x.toUpperCase()),
    linearUrl: env.DADAGUARD_ATTESA_LINEAR_URL || null,
    publicUrl: env.DADAGUARD_PUBLIC_URL || null,
    ramoProduzione: rami.produzione || 'main',
    ramoStaging: rami.staging || 'staging',
  }
}

const chiave = (r) => `${r.owner}/${r.repo}`.toLowerCase()

// I repository da guardare, dal payload per-account di `/api/deploys`: quelli con un deploy RIUSCITO
// nell'account di staging (un repository che esiste solo in produzione non ha un ramo di staging da
// confrontare), con i commit dell'ultimo deploy per servizio nei due ambienti. L'IaC resta fuori: ha
// il suo report di drift, e i suoi rami non sono ambienti. Puro.
export function repoDaGuardare(perAccount = {}, { extra = [], esclusi = new Set(), org = null } = {}) {
  const out = new Map()
  const prendi = (r) => {
    const k = chiave(r)
    if (!out.has(k)) out.set(k, { owner: r.owner, repo: r.repo, servizi: [], deploy: { staging: [], produzione: [] } })
    return out.get(k)
  }
  const perAmbiente = { staging: [], produzione: [] }
  for (const [conto, dati] of Object.entries(perAccount)) {
    const amb = ambienteDi(conto)
    if (!amb) continue
    for (const [servizio, b] of ultimoRilascioPerServizio(dati?.builds ?? dati ?? [])) {
      if (b.iac) continue
      const r = repoDaUrl(b.repo)
      if (!r || esclusi.has(r.repo.toLowerCase()) || (org && r.owner.toLowerCase() !== org)) continue
      perAmbiente[amb].push({ r, servizio, commit: b.commit, quando: b.startedAt ?? null })
    }
  }
  for (const d of perAmbiente.staging) {
    const x = prendi(d.r)
    if (!x.servizi.includes(d.servizio)) x.servizi.push(d.servizio)
    x.deploy.staging.push({ servizio: d.servizio, commit: d.commit, quando: d.quando })
  }
  for (const d of perAmbiente.produzione) {
    const x = out.get(chiave(d.r))
    if (x) x.deploy.produzione.push({ servizio: d.servizio, commit: d.commit, quando: d.quando })
  }
  for (const r of extra) if (!esclusi.has(r.repo.toLowerCase())) prendi(r)
  return [...out.values()].sort((a, b) => a.repo.localeCompare(b.repo))
}

// I ticket di un commit: dal ramo delle sue PR (dove la convenzione li mette, in minuscolo) e dal
// titolo. Nel ramo si cerca senza badare alle maiuscole SOLO con i prefissi dichiarati: senza, in
// `fix/utf-8-names` si troverebbe il ticket UTF-8. Puro.
export function ticketDi({ titolo = '', rami = [] } = {}, team = []) {
  const valido = (k) => !team.length || team.includes(k.split('-')[0])
  const out = new Set()
  for (const m of String(titolo).matchAll(/\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g)) if (valido(m[1])) out.add(m[1])
  if (team.length)
    for (const ramo of rami)
      for (const m of String(ramo ?? '').matchAll(/(?:^|[^a-z0-9])([a-z][a-z0-9]{1,9}-\d{1,6})(?=$|[^0-9])/gi)) {
        const k = m[1].toUpperCase()
        if (valido(k)) out.add(k)
      }
  return [...out]
}

const corto = (sha) => (sha ? String(sha).slice(0, 7) : null)

// Il ritardo di UN repository, dai dati già letti: il compare, le PR dei commit, le punte dei rami e
// i commit dei deploy. I merge (due genitori) non contano come lavoro in attesa: sono il modo in cui
// il lavoro è arrivato, e contarli raddoppierebbe ogni PR mergiata con un merge commit. Ma il loro
// messaggio porta il nome del ramo, quindi i ticket si leggono anche da lì. Puro.
export function ritardoRepo(r, { confronto = null, pr = new Map(), punte = {}, team = [], ora = Date.now() } = {}) {
  const commits = confronto?.commits ?? []
  const veri = commits.filter((c) => (c.parents?.length ?? 1) < 2)
  const date = veri.map((c) => Date.parse(c.commit?.committer?.date ?? c.commit?.author?.date ?? '')).filter(Number.isFinite)
  const autori = [...new Set(veri.map((c) => c.author?.login ?? c.commit?.author?.name).filter(Boolean))]
  const ticket = new Set()
  for (const c of commits) {
    const titolo = String(c.commit?.message ?? '').split('\n')[0]
    const rami = (pr.get(c.sha) ?? []).map((p) => p.ramo)
    // Il messaggio di un merge commit dice il ramo: «Merge pull request #40 from org/utente/abc-123-…».
    const daMerge = /^Merge (?:pull request #\d+ from |branch ')(\S+?)'?(?:\s|$)/.exec(titolo)?.[1]
    for (const k of ticketDi({ titolo, rami: daMerge ? [...rami, daMerge] : rami }, team)) ticket.add(k)
  }
  // `total_commits` conta anche i merge: si tolgono quelli visti, e il resto (oltre la pagina) si
  // prende com'è.
  const totale = confronto ? Math.max(veri.length, (confronto.total_commits ?? commits.length) - (commits.length - veri.length)) : null

  const mancato = (amb, punta) => {
    if (!punta?.sha) return null
    const deploy = r.deploy?.[amb] ?? []
    if (!deploy.length) return null
    // Una punta spostata da poco ha il deploy in corso: non è un deploy mancato.
    if (Number.isFinite(Date.parse(punta.quando)) && ora - Date.parse(punta.quando) < DEPLOY_IN_CORSO_MS) return null
    const fermi = deploy.filter((d) => d.commit && corto(d.commit) !== corto(punta.sha))
    return fermi.length ? { punta: corto(punta.sha), servizi: fermi.map((d) => ({ servizio: d.servizio, commit: corto(d.commit) })) } : null
  }

  return {
    repo: r.repo,
    owner: r.owner,
    servizi: r.servizi ?? [],
    inAttesa: totale,
    piuVecchio: date.length ? new Date(Math.min(...date)).toISOString() : null,
    giorni: date.length ? Math.floor((ora - Math.min(...date)) / GIORNO_MS) : null,
    vecchio: date.length ? ora - Math.min(...date) > VECCHIO_MS : false,
    autori,
    ticket: [...ticket].sort(),
    stagingNonRilasciato: mancato('staging', punte.staging),
    produzioneNonRilasciata: mancato('produzione', punte.produzione),
  }
}

// Una riga ha qualcosa da dire se aspetta un commit, o se un ramo non è uscito nel suo ambiente.
export const daDire = (x) => Boolean(x.errore || x.inAttesa > 0 || x.stagingNonRilasciato || x.produzioneNonRilasciata)

// Legge tutto per i repository dati: un repository che non si legge diventa una riga d'errore, gli altri
// continuano. `github` è il client di notify/github.js (confronto, puntaRamo, prDelCommit).
export async function calcolaAttesa(repos, github, cfg, { ora = Date.now() } = {}) {
  const out = []
  for (const r of repos) {
    try {
      // Prima il ramo di produzione: se non si legge nemmeno quello, l'App non vede il repository, ed è
      // un errore da dire. Se si legge lui e manca solo il ramo di staging, il repository rilascia dritto
      // in produzione (un deploy di staging fatto dallo stesso ramo): non c'è niente da confrontare, e
      // una riga d'errore ogni mattina sarebbe rumore per sempre.
      const produzione = await github.puntaRamo(r, cfg.ramoProduzione, { ora })
      const staging = await github.puntaRamo(r, cfg.ramoStaging, { ora }).catch((err) => {
        if (err.status === 404) return null
        throw err
      })
      if (!staging) continue
      const confronto = await github.confronto(r, cfg.ramoProduzione, cfg.ramoStaging, { ora })
      const pr = new Map()
      for (const c of (confronto?.commits ?? []).slice(-MAX_PR_PER_REPO)) {
        // Una PR non letta toglie un ticket, non la riga: il ticket del titolo resta.
        pr.set(c.sha, await github.prDelCommit(r, c.sha, { ora, base: cfg.ramoStaging }).catch(() => []))
      }
      out.push(ritardoRepo(r, { confronto, pr, punte: { staging, produzione }, team: cfg.team, ora }))
    } catch (err) {
      out.push({ repo: r.repo, owner: r.owner, servizi: r.servizi ?? [], errore: err.message })
    }
  }
  return out
}

const plurale = (n, uno, tanti) => (n === 1 ? uno : tanti)
const quanto = (giorni) => (giorni == null ? '' : giorni < 1 ? ' da oggi' : ` da ${giorni} ${plurale(giorni, 'giorno', 'giorni')}`)

// La riga di un repository. Il nome è quello del repository: è quello che si confronta su GitHub, e un
// repository con più servizi (un'API e il suo scheduler) ha un ramo solo. Puro.
export function rigaAttesa(x, { linearUrl = null } = {}) {
  const nome = `\`${x.repo}\``
  if (x.errore) return `⚠️ ${nome}: non letto da GitHub (${x.errore}), quindi qui non si sa cosa aspetta`
  const pezzi = []
  if (x.inAttesa > 0) {
    const autori = x.autori.length > MAX_AUTORI ? `${x.autori.slice(0, MAX_AUTORI).join(', ')} +${x.autori.length - MAX_AUTORI}` : x.autori.join(', ')
    const ticket = x.ticket.slice(0, MAX_TICKET).map((k) => (linearUrl ? `<${linearUrl}${k}|${k}>` : k))
    if (x.ticket.length > MAX_TICKET) ticket.push(`+${x.ticket.length - MAX_TICKET}`)
    pezzi.push(
      `${x.inAttesa} ${plurale(x.inAttesa, 'commit', 'commit')} in staging e non in produzione${quanto(x.giorni)}` +
        (autori ? ` (${autori})` : '') +
        (ticket.length ? ` · ${ticket.join(', ')}` : ''),
    )
  }
  const fermo = (tag, m) =>
    `[${tag}] ultimo deploy su ${m.servizi.map((s) => `${s.commit}`).filter((v, i, a) => a.indexOf(v) === i).join('/')}, il ramo è a ${m.punta}`
  if (x.produzioneNonRilasciata) pezzi.push(fermo('PROD', x.produzioneNonRilasciata))
  if (x.stagingNonRilasciato) pezzi.push(fermo('STAGING', x.stagingNonRilasciato))
  return `${x.vecchio ? '🔴 ' : ''}${nome}: ${pezzi.join(' · ')}`
}

// Il messaggio intero, o `null` quando non c'è niente da dire. Puro.
export function messaggioAttesa(righe = [], { linearUrl = null, publicUrl = null, erroreGenerale = null } = {}) {
  if (erroreGenerale) return `${TITOLO}\n⚠️ i deploy non si sono potuti leggere (${erroreGenerale}): oggi non so dire cosa aspetta la produzione`
  const dette = righe.filter(daDire).sort((a, b) => Number(Boolean(b.errore)) - Number(Boolean(a.errore)) || (b.giorni ?? -1) - (a.giorni ?? -1))
  if (!dette.length) return null
  const link = publicUrl ? `\n<${publicUrl.replace(/\/$/, '')}/api/attesa?format=testo|Il dettaglio in Dadaguard>` : ''
  return `${TITOLO}\n${dette.map((x) => `• ${rigaAttesa(x, { linearUrl })}`).join('\n')}${link}`
}

// La forma TESTO di `/api/attesa`: anche «allineato», che nel messaggio Slack si tace. Puro.
export function testoAttesa(righe = []) {
  if (!righe.length) return 'nessun repository applicativo da confrontare'
  return righe.map((x) => (daDire(x) ? rigaAttesa(x).replace(/[*`]/g, '') : `${x.repo}: allineato`)).join('\n')
}

// L'ora locale nel fuso dato: giorno (AAAA-MM-GG), ora, e se è un giorno feriale. Puro.
export function oraLocale(ms, fuso) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  )
  return { giorno: `${p.year}-${p.month}-${p.day}`, ora: Number(p.hour), feriale: !['Sat', 'Sun'].includes(p.weekday) }
}

// Il messaggio di oggi c'è già nel canale? Si guarda la cronologia dall'inizio del giorno locale (un
// po' prima, per non sbagliare sul cambio d'ora): è la memoria che resta anche se il task riparte.
async function giaDettoOggi(cfg, ora, api) {
  const r = await api('conversations.history', { channel: cfg.canale, oldest: String(Math.floor((ora - 26 * 3_600_000) / 1000)), limit: '100' }, cfg.botToken)
  const oggi = oraLocale(ora, cfg.fuso).giorno
  return (r.messages ?? []).some((m) => String(m.text ?? '').startsWith(TITOLO) && oraLocale(Number(m.ts) * 1000, cfg.fuso).giorno === oggi)
}

// Un giro: se è l'ora giusta di un giorno feriale e oggi non si è ancora detto, legge e scrive.
// `mem.giorno` evita di rifare il giro a ogni tick dell'ora quando oggi si è già deciso (anche di
// tacere); la cronologia del canale copre il riavvio del task, che quella memoria la perde.
export async function giroAttesa(cfg, { leggiDeploy, github, ora = Date.now(), api = chiamaSlack, mem = {} } = {}) {
  const t = oraLocale(ora, cfg.fuso)
  if (!t.feriale || t.ora !== cfg.ora) return { fatto: false, motivo: 'fuori orario' }
  if (mem.giorno === t.giorno) return { fatto: false, motivo: 'già fatto oggi' }
  // Una cronologia che non si legge (scope mancante) non deve spegnere il messaggio: si va avanti con
  // la sola memoria, e al peggio un riavvio nell'ora lo ripete una volta.
  const detto = await giaDettoOggi(cfg, ora, api).catch((err) => (log.warn('attesa: cronologia del canale non letta', { err: err.message }), false))
  if (detto) {
    mem.giorno = t.giorno
    return { fatto: false, motivo: 'già detto oggi' }
  }
  mem.giorno = t.giorno
  let testo
  try {
    const repos = repoDaGuardare(await leggiDeploy(), { extra: cfg.extra, esclusi: cfg.esclusi, org: github.org })
    testo = messaggioAttesa(await calcolaAttesa(repos, github, cfg, { ora }), cfg)
  } catch (err) {
    testo = messaggioAttesa([], { erroreGenerale: err.message })
  }
  if (!testo) {
    log.info('attesa: niente aspetta la produzione, oggi si tace')
    return { fatto: true, inviato: false }
  }
  // Un invio fallito si riprova al tick dopo, finché l'ora dura.
  await api('chat.postMessage', { channel: cfg.canale, text: testo, unfurl_links: false, unfurl_media: false }, cfg.botToken).catch((err) => {
    mem.giorno = null
    throw err
  })
  log.info('attesa: messaggio inviato', { canale: cfg.canale })
  return { fatto: true, inviato: true }
}

// Parte solo con canale, token del bot e App GitHub. Un giro ogni 5 minuti: basta che uno cada nell'ora
// scelta, e fuori da quell'ora non chiama niente.
export function startAttesa(leggiDeploy, github, env = process.env) {
  const cfg = attesaConfig(env)
  if (!cfg.canale || !cfg.botToken) {
    log.info('attesa: nessun DADAGUARD_ATTESA_CANALE o token del bot, messaggio del mattino spento')
    return null
  }
  if (!github) {
    log.warn('attesa: senza la GitHub App non si confrontano i rami, messaggio del mattino spento')
    return null
  }
  log.info('attesa: attiva', { ora: cfg.ora, fuso: cfg.fuso })
  const mem = {}
  const tick = () => giroAttesa(cfg, { leggiDeploy, github, mem }).catch((err) => log.error('attesa: giro fallito', { err: err.message }))
  tick()
  const timer = setInterval(tick, 5 * 60_000)
  timer.unref?.()
  return timer
}
