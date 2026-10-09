import { log } from '../log.js'
import { ambienteDi } from '../rilasci.js'
import { makeT } from '../i18n.js'
import { postSlack } from './slack.js'
import { statoCron, statoReaper, motivoCorsa, contaCron, verdettoCron } from '../../shared/cron.js'
import { etichetteCron, repoDelCodice } from '../../shared/codice.js'
import {
  AMBIENTI,
  quadroConfig,
  regoleSquadre,
  squadraDiRegole,
  nomeBreve,
  cella,
  quandoBreve,
  dalle,
  chiamaSlack,
  scaricaSlack,
  lettoreCanali,
  allineaCanvas,
  guardiaQuadro,
  eta,
} from './quadro.js'

// Il canvas delle CORSE dei cron: com'è andata l'ultima esecuzione di ogni cron, letto in Slack senza
// aprire la pagina Cron di Dadaguard. Il quadro dei deploy (server/notify/quadro.js) dice cosa è stato
// RILASCIATO; questo dice cosa è GIRATO, che è un'altra domanda («il report di stanotte è partito?»)
// con un altro dato (i log delle corse, non le build).
//
// Un canvas per CANALE, ognuno col suo sottoinsieme di cron: `tutti` li ha tutti, una squadra ha i
// suoi. Chi possiede quale cron NON si scrive qui: lo dice `DADAGUARD_QUADRO_SQUADRE`, la stessa riga
// che divide il quadro dei deploy nelle schede delle squadre (vedi `squadraCron`), così una sola
// definizione decide le due cose e non possono divergere. Il verdetto in cima a ogni canvas conta solo
// i suoi cron.
//
// Dice le STESSE cose della pagina Cron: lo stato di un cron (`statoCron`), il motivo di un fallimento
// (`motivoCorsa`) e il verdetto (`contaCron`, `verdettoCron`) vengono da shared/cron.js, le parole da
// chiavi che server/i18n.js ha uguali a web/i18n.jsx. Cambia solo il tempo: la pagina dice «3 h fa»,
// il canvas «oggi 03:10», perché un tempo relativo cambia ogni minuto e riscriverebbe il canvas per
// niente (vedi `alle` in quadro.js).
//
// Della parte che parla con Slack si riusa tutto dal quadro: ritrovare il canvas fra le schede del
// canale, crearlo se manca (anche cancellato a mano), rinominarlo, rileggerne l'HTML e riscrivere le
// sole celle cambiate (`allineaCanvas`). Per questo la forma è la stessa: un titolo per sezione, un
// paragrafo, una tabella con le righe sempre nello STESSO ORDINE (alfabetico) e un paragrafo in fondo.
//
// ⚠️ Perché le righe non si ordinano per gravità, anche se quello che si cerca per primo è un cron
// fallito: una riga che si sposta quando il suo cron passa da «in corso» a «ok» cambia la forma della
// tabella, e una forma diversa vuol dire riscrivere il canvas intero, cioè lo sdoppio che l'app di Slack
// mostra a canvas aperto (05/10/2026, in quadro.js). Con cron che girano ogni cinque minuti sarebbe a
// ogni giro. Quindi i problemi vanno IN CIMA in un paragrafo loro («Da guardare»: falliti, poi non
// partiti, poi in corso, produzione prima di staging), e la tabella resta ferma.
//
// Configurazione (spento se manca una delle due):
//   DADAGUARD_SLACK_BOT_TOKEN   lo stesso token del quadro: nessun permesso nuovo (canvases:write,
//                               canvases:read, files:read, channels:read, groups:read ci sono già)
//   DADAGUARD_CORSE_CANALI      un canale per canvas, `tutti=C0123,data=C0456`: la chiave è `tutti`
//                               (ogni cron) o il nome di una squadra di `DADAGUARD_QUADRO_SQUADRE`. Una
//                               squadra che lì non c'è si dice nel log e si salta: mostrare tutto al
//                               suo posto sarebbe un canvas di squadra che mente
//   DADAGUARD_CORSE_INTERVAL    secondi fra i giri (default 300, minimo 120)
//   DADAGUARD_PUBLIC_URL        per i link alla pagina Cron (`/cron?cron=<account>/<nome>`)
//   DADAGUARD_CORSE_INFRA       la squadra i cui cron vanno in fondo, in sezioni «Infra» loro, nel
//                               canvas `tutti` e nella pagina Cron (default `infra`). Vale solo se
//                               quella squadra è definita in `DADAGUARD_QUADRO_SQUADRE`: senza, niente
//                               sezione a parte. I suoi cron contano nel verdetto come gli altri
//   DADAGUARD_GITHUB_ORG/_REF   per il link al codice accanto al nome (vedi server/codice.js)
//
// IL NOME di una riga è il percorso del codice (il tag `Codice` della risorsa, vedi shared/codice.js),
// non lo schedule: `acme-crons/email-clienti` dice dove guardare, `email-clienti` no. Senza tag resta il
// nome breve di oggi. Il link del nome resta quello alla pagina Cron di Dadaguard (la cosa che si fa
// da una riga rossa è aprirne le corse e i log), e il codice ha il SUO link accanto, ` · codice`: in
// una cella di tabella di Slack due link distinti si leggono meglio di un nome che porta in un posto e
// di un'icona da indovinare.

// Ogni 5 minuti, e non ogni 15 secondi come il quadro: le letture del quadro sono API gratuite e
// veloci, queste sono i log delle corse (vedi `datiCorse` in server/index.js per quanto costano). E un
// cron che gira ogni 5 minuti non ha niente di nuovo da dire più spesso.
const DEFAULT_INTERVAL_S = 300
const MIN_INTERVAL_S = 120
// Le celle riscritte in un giro, in tutti i canvas delle corse insieme. Il quadro ne spende fino a 10
// ogni 15 secondi (40 al minuto) sulle ~50 modifiche di canvas al minuto che Slack regge: qui ne
// restano poche, e ogni 5 minuti bastano. Quello che avanza va al giro dopo.
export const MAX_MODIFICHE_CORSE = 8
export const TUTTI = 'tutti'
export const SQUADRA_INFRA = 'infra'
export const INTESTAZIONE_CORSE = ['Cron', 'Stato', 'Ultima corsa', 'Prossima']
// Quanti cron il paragrafo «Da guardare» nomina: oltre, li conta.
const MAX_DA_GUARDARE = 12
const MOTIVO_BREVE = 60
const VUOTO = 'n/d'
const SEP = ' · '

export const titoloCorse = (chiave) => `Corse cron ${String(chiave).toUpperCase()}`

export function corseConfig(env = process.env) {
  const q = quadroConfig(env)
  // `tutti=C0123,data=C0456`, nell'ordine scritto. Le chiavi in minuscolo come le squadre del quadro.
  const voci = String(env.DADAGUARD_CORSE_CANALI ?? '')
    .split(',')
    .map((x) => x.split('=').map((y) => y.trim()))
    .filter(([k, id]) => k && id)
    .map(([k, id]) => ({ chiave: k.toLowerCase(), canale: id }))
  const nota = (k) => k === TUTTI || Object.hasOwn(q.squadre, k)
  const infra = String(env.DADAGUARD_CORSE_INFRA ?? '').trim().toLowerCase() || SQUADRA_INFRA
  return {
    token: q.token,
    publicUrl: q.publicUrl,
    squadre: q.squadre,
    // La squadra delle sezioni «Infra», solo se esiste: una sezione per una squadra che nessuno ha
    // definito sarebbe sempre vuota, e un default che pesca cron a caso non è generico.
    infra: Object.hasOwn(q.squadre, infra) ? infra : null,
    canali: voci.filter((v) => nota(v.chiave)),
    // Le chiavi che non sono `tutti` né una squadra conosciuta: si dicono una volta all'avvio.
    ignote: voci.filter((v) => !nota(v.chiave)).map((v) => v.chiave),
    intervalMs: Math.max(MIN_INTERVAL_S, Number(env.DADAGUARD_CORSE_INTERVAL) || DEFAULT_INTERVAL_S) * 1000,
  }
}

// ── I cron di un canale ──────────────────────────────────────────────────────────────────────────

// La squadra di un cron, con le regole del quadro dei deploy (`squadraDiRegole`): prima il repository
// dell'immagine (i cron ECS, che lo leggono dalla task definition, vedi `ecsRuns`), poi i glob sul nome
// breve. Il nome breve si prova su quello dello schedule, della famiglia della task definition e della
// funzione: lo schedule può chiamarsi diverso dalla risorsa che il quadro conosce, e un glob scritto
// per una delle due deve prendere il cron lo stesso.
// Il repository del CODICE (il tag `Codice`, vedi shared/codice.js) vale come quello dell'immagine: è
// il sorgente di quello che gira, cioè la stessa cosa che il quadro chiama «repository» per un servizio
// (il sorgente della build). È anche l'unico repository che un cron Lambda ha.
// ⚠️ Un cron ECS SPENTO non legge le corse (vedi runsOverview), quindi senza repository dell'immagine:
// entra in una squadra dal Codice, se ce l'ha, o se un glob lo prende. Puro/testabile.
export function squadraCron(cron, regole) {
  const nomi = [cron?.name, cron?.family, cron?.function].filter(Boolean).map((n) => nomeBreve(n))
  return squadraDiRegole(regole, [cron?.immagine, repoDelCodice(cron?.codice)], nomi)
}

// La lista divisa fra i cron del prodotto e quelli della squadra `infra` (vedi `corseConfig`): i secondi
// vanno in fondo, in una parte loro, perché chi apre il canvas o la pagina cerca prima i cron del
// prodotto, e un giro di housekeeping dell'infrastruttura in mezzo li allontana. Senza squadra infra
// tutto è prodotto. Puro/testabile.
export function divideInfra(crons = [], squadre = {}, infra = null) {
  if (!infra) return { prodotto: crons, infra: [] }
  const regole = regoleSquadre(squadre)
  const prodotto = []
  const suoi = []
  for (const c of crons) (squadraCron(c, regole) === infra ? suoi : prodotto).push(c)
  return { prodotto, infra: suoi }
}

// `infra: true` sui cron della squadra infra, per la pagina Cron (che le squadre non le conosce: stanno
// nella configurazione del server). Non toglie e non sposta niente. Puro/testabile.
export function conInfra(overview = {}, cfg = {}) {
  if (!Array.isArray(overview.crons) || !cfg.infra) return overview
  const { infra } = divideInfra(overview.crons, cfg.squadre ?? {}, cfg.infra)
  const suoi = new Set(infra.map((c) => c.key))
  return { ...overview, crons: overview.crons.map((c) => (suoi.has(c.key) ? { ...c, infra: true } : c)) }
}

// I cron che vanno nel canvas di una chiave: tutti, o quelli della squadra. Puro/testabile.
export function cronDelCanale(crons = [], chiave, squadre = {}) {
  if (chiave === TUTTI) return crons
  const regole = regoleSquadre(squadre)
  return crons.filter((c) => squadraCron(c, regole) === chiave)
}

// ── La resa ──────────────────────────────────────────────────────────────────────────────────────

const EMOJI_LIVELLO = { crit: '❌', warn: '⚠️', info: '⏳', ok: '✅', off: '➖' }
const RANGO_LIVELLO = { crit: 0, warn: 1, info: 2, ok: 3, off: 4 }
const RANGO_AMBIENTE = { produzione: 0, staging: 1 }
const rangoAmbiente = (account) => RANGO_AMBIENTE[ambienteDi(account ?? '')] ?? 2
const tronca = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))
const perNome = (a, b) => a.localeCompare(b, 'it', { sensitivity: 'base', numeric: true }) || (a < b ? -1 : a > b ? 1 : 0)

// La durata di una corsa: «45 s», «6 min», «1 h 20 min». Puro.
export function durataCorsaTesto(ms) {
  if (!(ms >= 0) || ms == null) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const min = Math.round(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
}

// La cadenza di uno schedule `rate(...)`, quando l'ora della prossima corsa non si sa. Puro.
function ogni(minuti) {
  if (!(minuti > 0)) return null
  if (minuti < 60) return `ogni ${minuti} min`
  if (minuti % 1440 === 0) return minuti === 1440 ? 'ogni giorno' : `ogni ${minuti / 1440} g`
  return minuti % 60 === 0 ? `ogni ${minuti / 60} h` : `ogni ${minuti} min`
}

const durataDi = (r) => (r?.durationMs != null ? r.durationMs : r?.startedAt && r?.endedAt ? r.endedAt - r.startedAt : null)

// Il link a UN cron sulla pagina Cron: `?cron=` la apre già filtrata su quel cron (web/pages/RunsPage.jsx).
export const linkCron = (cron, url) => (url && cron?.key ? `${url}/cron?cron=${encodeURIComponent(cron.key)}` : null)

// «Cosa è successo» di un cron, come lo dice la pagina (`cosaCron` in web/pages/RunsPage.jsx), con
// l'orario fisso al posto di «X fa». Puro/testabile.
export function ultimaCorsaTesto(c, stato, { ora = Date.now(), t = makeT('it') } = {}) {
  const runs = c.runs ?? []
  const viva = runs.find((r) => r.running)
  const ultima = runs.find((r) => !r.running)
  if (viva) {
    // «dalle 08:41» e non «da 12 min»: fisso, come ogni tempo del canvas.
    const prima = ultima?.outcome === 'failed' ? `prima: ${tronca(motivoCorsa(ultima, t) ?? t('rilasci.cron.stato.crit'), MOTIVO_BREVE)}` : null
    return [`In corso ${viva.startedAt ? dalle(viva.startedAt, ora) : ''}`.trim(), prima].filter(Boolean).join(SEP)
  }
  if (!runs.length) {
    if (stato === 'off') return t('rilasci.cron.spentoHint')
    return [t('rilasci.cron.nonPartito'), c.error && `errore: ${tronca(c.error, MOTIVO_BREVE)}`].filter(Boolean).join(SEP)
  }
  const quando = quandoBreve(ultima?.startedAt, ora) ?? '?'
  if (ultima?.outcome === 'failed') return [t('rilasci.cron.fallito', { quando }), tronca(motivoCorsa(ultima, t), MOTIVO_BREVE)].filter(Boolean).join(SEP)
  if (ultima?.outcome === 'unknown') return t('rilasci.cron.ignoto', { quando })
  return t('rilasci.cron.ok', { quando, d: durataCorsaTesto(durataDi(ultima)) ?? '?' })
}

// Una riga della tabella: nome, stato, ultima corsa, prossima, e le celle pronte per il canvas.
// Puro/testabile.
export function rigaCorsa(c, { ora = Date.now(), url = null, t = makeT('it') } = {}) {
  const stato = statoCron(c)
  // L'etichetta la decide `canvasCorse` sulla lista del canvas (percorso del codice, distinto se due
  // job lanciano lo stesso script); chiamata da sola, la riga ha il nome breve di oggi.
  const nome = c.etichetta ?? nomeBreve(c.name)
  const link = linkCron(c, url)
  const prossima = c.enabled === false ? t('rilasci.cron.spento') : c.nextRunAt ? quandoBreve(c.nextRunAt, ora) : (ogni(c.scheduleMinutes) ?? VUOTO)
  // Il reaper dentro la riga (shared/codice.js) si NOMINA solo quando è un problema: a posto non ha
  // niente da dire, e una cella che lo ripete su ogni job lungo è rumore.
  const sr = statoReaper(c)
  const reaper = sr && stato !== 'off' && (sr === 'crit' || sr === 'warn') ? `reaper: ${ultimaCorsaTesto(c.reaper, sr, { ora, t })}` : null
  const ultima = [ultimaCorsaTesto(c, stato, { ora, t }), reaper].filter(Boolean).join(SEP) || VUOTO
  const nomeCella = link ? `[**${nome}**](${link})` : `**${nome}**`
  return {
    nome,
    stato,
    account: c.account ?? null,
    link,
    celle: [
      cella(c.codiceUrl ? `${nomeCella}${SEP}[codice](${c.codiceUrl})` : nomeCella),
      cella(`${EMOJI_LIVELLO[stato]} ${t(`rilasci.cron.stato.${stato}`)}`),
      cella(ultima),
      cella(prossima),
    ],
  }
}

// Il verdetto su un gruppo di cron, in una riga: la parte forte in grassetto, come in cima alla pagina.
// Puro/testabile.
export function verdettoTesto(crons = [], { t = makeT('it') } = {}) {
  const conti = contaCron(crons)
  const v = verdettoCron(conti)
  return { livello: v.livello, conti, testo: `${EMOJI_LIVELLO[v.livello]} **${t(...v.forte)}**${v.resto ? t(...v.resto) : ''}` }
}

// Le sezioni di un canvas: una per ACCOUNT, produzione prima di staging, poi gli altri per nome. Il
// titolo è l'ambiente, con l'account accanto solo se lo stesso ambiente ha più account. Un account le
// cui schedule non si sono lette (`problemi`) ha la sua sezione lo stesso, senza righe: le righe che
// il canvas ha già restano com'erano (vedi `tollera` in `pianoCelle`), e il paragrafo lo dice.
// Puro/testabile.
export function sezioniCorse(crons = [], { etichette = {}, problemi = [], ora = Date.now(), url = null, t = makeT('it') } = {}) {
  const perAccount = new Map()
  for (const c of crons) {
    const k = c.account ?? '?'
    if (!perAccount.has(k)) perAccount.set(k, [])
    perAccount.get(k).push(c)
  }
  const errori = new Map(problemi.filter((p) => p?.account).map((p) => [p.account, p.error ?? 'non letto']))
  for (const k of errori.keys()) if (!perAccount.has(k)) perAccount.set(k, [])
  const chiavi = [...perAccount.keys()].sort((a, b) => rangoAmbiente(a) - rangoAmbiente(b) || perNome(etichette[a] ?? a, etichette[b] ?? b))
  const quantiPerAmbiente = new Map()
  for (const k of chiavi) {
    const a = ambienteDi(k)
    if (a) quantiPerAmbiente.set(a, (quantiPerAmbiente.get(a) ?? 0) + 1)
  }
  return chiavi.map((k) => {
    const lista = perAccount.get(k)
    const amb = ambienteDi(k)
    const etichetta = etichette[k] ?? k
    const titolo = amb ? (quantiPerAmbiente.get(amb) > 1 ? `${AMBIENTI[amb].sezione}${SEP}${etichetta}` : AMBIENTI[amb].sezione) : etichetta
    const righe = lista.map((c) => rigaCorsa(c, { ora, url, t })).sort((a, b) => perNome(a.nome, b.nome))
    const errore = errori.get(k)
    const sintesi = errore
      ? `⚠️ **cron non letti**: ${cella(tronca(errore, 200))}`
      : `${verdettoTesto(lista, { t }).testo}${SEP}${lista.length} cron`
    return { account: k, ambiente: amb, tag: amb ? AMBIENTI[amb].tag : etichetta, titolo, sintesi, righe, tollera: Boolean(errore) }
  })
}

// Il paragrafo «Da guardare»: i cron falliti, poi i non partiti, poi quelli in corso, produzione prima
// di staging e per nome, ognuno col link alla sua pagina. È la parte che si legge per prima, e quella
// che ordina per gravità al posto della tabella. Puro/testabile.
export function daGuardare(sezioni = [], { max = MAX_DA_GUARDARE } = {}) {
  const voci = sezioni
    .flatMap((s, i) => s.righe.filter((r) => ['crit', 'warn', 'info'].includes(r.stato)).map((r) => ({ ...r, tag: s.tag, ordine: i })))
    .sort((a, b) => RANGO_LIVELLO[a.stato] - RANGO_LIVELLO[b.stato] || a.ordine - b.ordine || perNome(a.nome, b.nome))
  if (!voci.length) return 'Da guardare: niente'
  const nomi = voci.slice(0, max).map((r) => `${EMOJI_LIVELLO[r.stato]} ${r.link ? `[${r.nome}](${r.link})` : r.nome} (${r.tag})`)
  const altri = voci.length > max ? ` e altri ${voci.length - max}` : ''
  return `**Da guardare**: ${nomi.join(SEP)}${altri}`
}

// Il canvas di una chiave: il riepilogo (verdetto e «Da guardare»), poi una sezione per account. Esce
// il markdown (per crearlo o riscriverlo intero) e il MODELLO che `pianoCelle` confronta con quello che
// legge nel canvas. La forma è fissa come quella del quadro: quello che va e viene cambia il testo di un
// paragrafo che c'è sempre. Niente «aggiornato alle»: cambierebbe a ogni giro. Puro/testabile.
//
// Le ETICHETTE delle righe si decidono qui, sulla lista di QUESTO canvas: due job con lo stesso Codice
// si distinguono solo se stanno nello stesso canvas (vedi `etichetteCron`). Senza Codice, il nome breve.
// Con `infra` (solo nel canvas `tutti`, vedi `canvasCorseDaScrivere`) i cron di quella squadra vanno in
// sezioni loro IN FONDO, «Infra · <ambiente>», dopo quelle del prodotto: il riepilogo in cima li conta
// lo stesso, e un loro guasto sta in «Da guardare» come gli altri.
export function canvasCorse(
  chiave,
  crons = [],
  { etichette = {}, problemi = [], ora = Date.now(), url = null, finestraOre = 24, t = makeT('it'), squadre = {}, infra = null } = {},
) {
  const breve = (c) => nomeBreve(c.name)
  const nomi = etichetteCron(crons, { nome: breve, breve })
  const conNome = crons.map((c) => ({ ...c, etichetta: nomi.get(c.key) }))
  const parti = divideInfra(conNome, squadre, infra)
  const sezioni = [
    ...sezioniCorse(parti.prodotto, { etichette, problemi, ora, url, t }),
    ...sezioniCorse(parti.infra, { etichette, ora, url, t }).map((s) => ({ ...s, titolo: `Infra${SEP}${s.titolo}` })),
  ]
  const verdetto = verdettoTesto(crons, { t })
  const dadaguard = url ? `${SEP}[Cron su Dadaguard](${url}/cron)` : ''
  // «Tutti i cron sono a posto» su zero cron sarebbe vero e inutile, e con un account non letto non lo
  // si sa: lo si dice accanto al verdetto, che vale solo per i cron letti.
  const nonLetti = sezioni.filter((s) => s.tollera).map((s) => s.titolo)
  const sintesi = crons.length ? `${verdetto.testo}${SEP}${crons.length} cron` : '➖ **nessun cron**'
  const riepilogo = {
    titolo: 'Riepilogo',
    sintesi: nonLetti.length ? `${sintesi}${SEP}⚠️ non letti: ${nonLetti.join(', ')}` : sintesi,
    righe: [],
    fondo: `${daGuardare(sezioni)}  |  ultime ${finestraOre} h${dadaguard}`,
  }
  const modello = {
    sezioni: [
      riepilogo,
      ...sezioni.map((s) => ({ titolo: s.titolo, sintesi: s.sintesi, righe: s.righe.map((r) => r.celle), fondo: null, tollera: s.tollera, intestazione: INTESTAZIONE_CORSE })),
    ],
  }
  const md = []
  for (const s of modello.sezioni) {
    md.push(`## ${s.titolo}`, s.sintesi)
    if (s.righe.length)
      md.push([`| ${INTESTAZIONE_CORSE.join(' | ')} |`, `|${INTESTAZIONE_CORSE.map(() => '---').join('|')}|`, ...s.righe.map((c) => `| ${c.join(' | ')} |`)].join('\n'))
    if (s.fondo) md.push(s.fondo)
  }
  return { chiave, titolo: titoloCorse(chiave), markdown: md.join('\n\n'), modello, livello: verdetto.livello, conti: verdetto.conti }
}

// Tutti i canvas di un giro, uno per canale, dalla STESSA lettura: i cron si leggono una volta e si
// filtrano per canale, quindi tre canali non sono tre giri sui log. Puro/testabile.
export function canvasCorseDaScrivere(dati, cfg, { ora = Date.now(), t = makeT('it') } = {}) {
  const ov = dati?.overview ?? {}
  // Solo i cron di AWS: l'orchestratore non ha un account, e la sua lista non la legge questo giro.
  const crons = (ov.crons ?? []).filter((c) => c.type !== 'prefect')
  const finestraOre = Math.round((ov.window ?? 1440) / 60)
  return (cfg.canali ?? []).map(({ chiave, canale }) => ({
    canale,
    ...canvasCorse(chiave, cronDelCanale(crons, chiave, cfg.squadre ?? {}), {
      etichette: dati?.etichette ?? {},
      problemi: ov.problems ?? [],
      ora,
      url: cfg.publicUrl ?? null,
      finestraOre,
      t,
      // Le sezioni «Infra» solo nel canvas di tutti: in quello di una squadra i cron sono già i suoi, e
      // in quello della squadra infra sarebbero tutti in fondo a un canvas senza nient'altro sopra.
      squadre: cfg.squadre ?? {},
      infra: chiave === TUTTI ? (cfg.infra ?? null) : null,
    }),
  }))
}

// ── Il giro ──────────────────────────────────────────────────────────────────────────────────────

// Un giro: legge una volta, poi allinea ogni canvas al suo canale. Un canvas che fallisce non ferma gli
// altri. `deps` per le prove: `leggiDati` ({ overview, etichette }), `api`, `scarica`, `ultimi` e
// `titoli` (la memoria fra un giro e l'altro), `maxModifiche`.
export async function aggiornaCorse(cfg, deps = {}) {
  const api = deps.api ?? ((m, c) => chiamaSlack(m, c, cfg.token))
  const scarica = deps.scarica ?? ((url) => scaricaSlack(url, cfg.token))
  const dati = await deps.leggiDati()
  const ora = deps.ora ?? Date.now()
  const { info, leggiHtml } = lettoreCanali(api, scarica)
  const ultimi = deps.ultimi ?? new Map()
  const titoli = deps.titoli ?? new Set()
  let budget = deps.maxModifiche ?? MAX_MODIFICHE_CORSE
  const esiti = []
  for (const c of canvasCorseDaScrivere(dati, cfg, { ora })) {
    try {
      const e = await allineaCanvas(api, c, { info, leggiHtml, ultimi, titoli, budget, nome: 'corse' })
      budget -= e.celle ?? 0
      esiti.push({ ambiente: `corse-${c.chiave}`, ...e })
    } catch (err) {
      esiti.push({ ambiente: `corse-${c.chiave}`, azione: 'errore', errore: err.message })
    }
  }
  return esiti
}

// La riga per il canale degli allarmi quando un canvas delle corse è fermo (stessa guardia del quadro,
// `guardiaQuadro`, e stessa grammatica). Puro/testabile.
export function testoAvvisoCorse(a, { ora = Date.now(), url = null } = {}) {
  const tag = String(a.ambiente).replace(/^corse-/, '').toUpperCase()
  if (a.tipo === 'rientrato') return `✅ \`corse cron\` [${tag}] rientrato · di nuovo aggiornato dopo ${eta(a.fermoDa, ora)} fermo`
  const link = url ? `${SEP}<${url}/cron|cron su Dadaguard>` : ''
  return `⚠️ \`corse cron\` [${tag}] FERMO · il canvas non si aggiorna da ${eta(a.fermoDa, ora)}${SEP}ultimo errore: ${tronca(a.errore ?? 'sconosciuto', 200)}${link}`
}

export function startCorse(leggiDati, env = process.env) {
  const cfg = corseConfig(env)
  // Una squadra scritta in DADAGUARD_CORSE_CANALI e non in DADAGUARD_QUADRO_SQUADRE: lo si dice una
  // volta, qui, e quel canale resta senza canvas. Mostrarci tutti i cron sarebbe un canvas di squadra
  // che dice il falso, e uno vuoto direbbe «niente da guardare» su cron che non ha guardato.
  for (const k of cfg.ignote)
    log.warn('corse: squadra senza definizione in DADAGUARD_QUADRO_SQUADRE, canale saltato', { squadra: k, note: `usa \`${TUTTI}\` o una squadra definita` })
  if (!cfg.token || !cfg.canali.length) {
    log.info('corse: nessun DADAGUARD_SLACK_BOT_TOKEN o DADAGUARD_CORSE_CANALI valido, canvas delle corse spento')
    return null
  }
  log.info('corse: attivo', { ogni: `${cfg.intervalMs / 1000}s`, canali: cfg.canali.map((c) => c.chiave) })
  const webhook = env.DADAGUARD_SLACK_WEBHOOK || null
  const avvio = Date.now()
  const ultimi = new Map()
  const titoli = new Set()
  let guardia = {}
  let inCorso = false
  const giro = async () => {
    const esiti = await aggiornaCorse(cfg, { leggiDati, ultimi, titoli }).catch((err) => {
      log.error('corse: giro fallito', { err: err.message })
      return cfg.canali.map((c) => ({ ambiente: `corse-${c.chiave}`, azione: 'errore', errore: err.message }))
    })
    const errori = esiti.filter((e) => e.azione === 'errore')
    if (errori.length) log.error('corse: giro con errori', { errori: errori.map((e) => `${e.ambiente}: ${e.errore}`) })
    if (esiti.some((e) => e.azione !== 'invariato')) log.info('corse: giro', { esiti: esiti.map((e) => `${e.ambiente}:${e.azione}`) })
    // Un canvas fermo dice «tutto a posto» con l'ora di ieri: la stessa guardia del quadro, con una
    // soglia che regge il giro più lungo (tre giri mancati prima di dirlo).
    const g = guardiaQuadro(guardia, esiti, { avvio, sogliaMs: Math.max(10 * 60_000, cfg.intervalMs * 3) })
    guardia = g.stato
    for (const a of g.avvisi) {
      const testo = testoAvvisoCorse(a, { url: cfg.publicUrl })
      log.warn('corse: avviso', { testo })
      if (webhook && !(await postSlack(webhook, { text: testo })) && a.tipo === 'fermo') guardia[a.ambiente].avvisato = false
    }
  }
  const tick = () => {
    // Un giro che dura più dell'intervallo (i log lenti) non se ne somma un altro sopra.
    if (inCorso) return
    inCorso = true
    giro()
      .catch((err) => log.error('corse: guardia fallita', { err: err.message }))
      .finally(() => {
        inCorso = false
      })
  }
  // Il primo giro aspetta un minuto e mezzo: all'avvio la pagina Cron scalda la sua cache sugli stessi log
  // (server/index.js), e due giri insieme si contenderebbero la quota.
  const primo = setTimeout(tick, 90_000)
  primo.unref?.()
  const timer = setInterval(tick, cfg.intervalMs)
  timer.unref?.()
  return timer
}
