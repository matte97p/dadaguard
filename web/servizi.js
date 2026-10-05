// Le regole della pagina Servizi e del pannello del servizio, separate dai componenti perche' sono
// quelle che decidono cosa si legge (la frase di una riga, quali controlli, quali link) e vanno
// provate senza un browser. Tutto tollerante: i campi nuovi del server (dettaglio, comando, altrove,
// slo, budgetErrore, team, slack, runbook) possono mancare, e allora si ricade su quello che c'e'.
import { livelloServizio } from './adattatori.js'
import { asList, matchesAny, corrispondeNome } from './filters.js'
import { countByStatus } from './format.js'
import { displayName } from './serviceName.js'

// Sigla del tipo nella casellina accanto al nome: dice DA DOVE arriva la riga prima di leggerla.
export const SIGLA = {
  lambda: 'λ',
  ecs: 'ECS',
  'ecs-scheduled': '⏱',
  'cloudflare-worker': 'CF',
  acm: 'TLS',
  s3: 'S3',
  rds: 'DB',
  kinesis: 'KIN',
  sfn: 'SFN',
  ec2: 'EC2',
  alb: 'ALB',
  elasticache: 'RED',
  bedrock: 'AI',
}

// I controlli, nell'ordine in cui si leggono: prima se risponde, poi se gira il codice giusto, poi
// come gira, poi quello che sta intorno. Le chiavi sono quelle di `checks` del server.
export const CONTROLLI = ['liveness', 'version', 'runtime', 'secrets', 'drift', 'security', 'alarms', 'backups']

// Livello di un singolo controllo: lo manda il server (`livello`, server/meta/stato.js). Senza,
// il controllo non e' stato letto e resta grigio, non diventa verde.
export const livelloControllo = (c) => livelloServizio({ livello: c?.livello })

export function controlliDi(s) {
  const ch = s?.checks ?? {}
  return CONTROLLI.filter((k) => ch[k]).map((k) => ({
    chiave: k,
    livello: livelloControllo(ch[k]),
    testo: ch[k].summary ?? ch[k].reason ?? null,
    check: ch[k],
  }))
}

// La frase «cosa succede» di una riga. Vince il `dettaglio` del server; poi il controllo colpevole
// (`cause`), che e' quello che ha reso rossa la riga; poi l'esecuzione, che su un servizio sano dice
// comunque qualcosa di utile (istanze, chiamate). Mai una frase inventata.
export function cosaSuccede(s) {
  if (typeof s?.dettaglio === 'string' && s.dettaglio) return s.dettaglio
  const causa = s?.cause ? s.checks?.[s.cause] : null
  const c = causa ?? s?.checks?.runtime ?? s?.checks?.liveness ?? null
  return c?.summary ?? c?.reason ?? null
}

// Il suggerimento sotto la frase: gli altri controlli che non vanno, se ce ne sono piu' d'uno.
export function altriProblemi(s) {
  const n = (s?.causes?.length ?? 0) - 1
  return n > 0 ? n : 0
}

// «Con problemi» = rosso o arancio, la stessa regola del verdetto in cima e dei badge del menu. Prima
// il filtro guardava `overall` (giu' e degradato) e il chip il livello: un servizio su con un drift
// arancio era «con problemi» per uno e non per l'altro.
export const conProblemi = (s) => {
  const l = livelloServizio(s)
  return l === 'crit' || l === 'warn'
}

// Il filtro della flotta, tutto insieme: ambiente, tendine, ricerca, problemi. `conStato: false`
// lascia fuori stato e «con problemi», ed e' la lista su cui si contano i chip: i numeri dicono
// cosa compare premendoli, e premuto «Giu'» gli altri chip continuano a dire quanti ce ne sono,
// invece di scendere a zero e togliere la strada per tornare indietro.
//
// La ricerca guarda anche il TIPO: «bedrock» nel campo deve trovare i modelli, che si chiamano
// «Claude Sonnet 4.5» e non contengono la parola. E' la domanda che ha fatto nascere questo codice.
export function passaFiltri(s, f = {}, { conStato = true } = {}) {
  const cron = Boolean(s?.checks?.runtime?.schedule)
  const schedule = f.scheduleFilter ?? 'all'
  const managed = f.managedFilter ?? 'all'
  return (
    matchesAny(s?.account?.key ?? '__none__', f.accountFilter) &&
    matchesAny(s?.region, f.regionFilter) &&
    matchesAny(s?.type, f.typeFilter) &&
    (!conStato || matchesAny(s?.overall, f.statusFilter)) &&
    (schedule === 'all' || (schedule === 'cron') === cron) &&
    (managed === 'all' || (managed === 'managed' ? s?.managed === true : s?.managed === false)) &&
    corrispondeNome(f.nameQuery, s?.name, displayName(s), s?.type) &&
    (!conStato || !f.problemsOnly || conProblemi(s))
  )
}

// Opzioni delle tendine, dai servizi che ci sono: un tipo che la flotta non ha non si offre, perche'
// sceglierlo darebbe una pagina vuota senza dire perche'. L'etichetta tradotta se c'e', la chiave se no.
const etichetta = (t, k, grezzo) => {
  const v = t(k)
  return v === k ? grezzo : v
}
export function opzioniTipo(servizi = [], t = (k) => k) {
  return [...new Set(servizi.map((s) => s?.type).filter(Boolean))]
    .map((ty) => ({ value: ty, label: etichetta(t, `type.${ty}`, ty) }))
    .sort((a, b) => a.label.localeCompare(b.label))
}
export function opzioniStato(servizi = [], t = (k) => k) {
  return countByStatus(servizi).map(({ status }) => ({ value: status, label: etichetta(t, `svc.stato.${status}`, status) }))
}

// La fila di chip sopra la lista: «Con problemi», «Tutti», e uno per stato col suo conteggio, dal
// peggio. Sono SCORCIATOIE degli stessi filtri delle tendine (`statusFilter`, `problemsOnly`), non
// uno stato a parte: due controlli per la stessa cosa finiscono a contraddirsi, e la lista vuota non
// dice quale dei due la sta svuotando.
export function vociChip(base = [], t = (k) => k) {
  return [
    { key: 'problemi', label: t('svc.chip.problemi'), n: base.filter(conProblemi).length },
    { key: 'tutti', label: t('svc.chip.tutti'), n: base.length },
    ...countByStatus(base).map(({ status, count }) => ({ key: status, label: etichetta(t, `svc.stato.${status}`, status), n: count })),
  ]
}

// Quale chip e' premuto. Stringa vuota = nessuno: succede quando dalla tendina si sceglie piu' di
// uno stato, o uno stato insieme a «con problemi», che nessun chip da solo rappresenta. Mostrare
// premuto «Tutti» li' sarebbe una bugia.
export function chipAttivo(f = {}) {
  const stati = asList(f.statusFilter)
  if (f.problemsOnly) return stati.length ? '' : 'problemi'
  if (stati.length === 0) return 'tutti'
  return stati.length === 1 ? stati[0] : ''
}

// Cosa cambia premendo un chip. Ripremere quello attivo torna a «Tutti», come prima del redesign:
// e' il gesto che ci si aspetta da un filtro che si accende con un clic.
export function premiChip(key, f = {}) {
  const tutti = { statusFilter: [], problemsOnly: false }
  if (key === 'tutti' || key === chipAttivo(f)) return tutti
  if (key === 'problemi') return { statusFilter: [], problemsOnly: true }
  return { statusFilter: [key], problemsOnly: false }
}

// Quante tendine sono scelte: e' il numero sul bottone «Filtri» del telefono, dove le tendine stanno
// chiuse. Senza, un filtro scelto ieri resta acceso sotto un bottone chiuso e la lista sembra corta
// per nessun motivo. L'account conta: sul telefono la tendina e' l'unico posto che lo mostra intero.
export function quanteTendine(f = {}) {
  return (
    [f.typeFilter, f.statusFilter, f.accountFilter, f.regionFilter].filter((l) => asList(l).length > 0).length +
    ((f.scheduleFilter ?? 'all') !== 'all' ? 1 : 0) +
    ((f.managedFilter ?? 'all') !== 'all' ? 1 : 0)
  )
}

// «Apri altrove»: i link che il server ha gia' composto e filtrato (`altrove`), poi quelli vecchi
// per nome (`links`), poi l'indirizzo pubblico del servizio. Doppioni tolti per url: lo stesso
// posto con due nomi e' rumore.
export function linkAltrove(s, t = (k) => k) {
  const out = []
  for (const a of Array.isArray(s?.altrove) ? s.altrove : []) {
    if (!a?.url) continue
    const k = `svc.altrove.${a.chiave}`
    const label = t(k)
    out.push({
      label: label === k ? a.chiave : label,
      href: a.url,
      nota: a.filtro ?? null,
    })
  }
  for (const [label, url] of Object.entries(s?.links ?? {})) if (url) out.push({ label, href: url, nota: null })
  if (s?.url)
    out.push({
      label: t('svc.altrove.servizio'),
      href: s.url,
      nota: s.url.replace(/^https?:\/\//, ''),
    })
  const visti = new Set()
  return out.filter((l) => (visti.has(l.href) ? false : (visti.add(l.href), true)))
}

// La disponibilita' del mese contro l'obiettivo. `budgetErrore.rimasto` e' una frazione del budget
// (negativa se sforato); il livello segue quanto ne resta: finito e' rosso, sotto il 30% arancio.
export function sloDi(s) {
  const b = s?.budgetErrore
  const obiettivo = b?.obiettivo ?? s?.slo ?? null
  if (obiettivo == null) return null
  if (!b || b.rimasto == null)
    return {
      obiettivo,
      disponibilita: b?.disponibilita ?? null,
      rimasto: null,
      livello: 'off',
      sforato: false,
    }
  const pct = Math.round(b.rimasto * 100)
  return {
    obiettivo,
    disponibilita: b.disponibilita ?? null,
    rimasto: pct,
    sforato: Boolean(b.sforato) || pct < 0,
    livello: pct < 0 || b.sforato ? 'crit' : pct < 30 ? 'warn' : 'ok',
  }
}

// Percentuale leggibile da una frazione (0.999 → «99,9»), con la virgola in italiano.
export function pct(frazione, lang = 'it', cifre = 1) {
  if (frazione == null || !Number.isFinite(Number(frazione))) return null
  const v = (Number(frazione) * 100).toFixed(cifre).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  return lang === 'it' ? v.replace('.', ',') : v
}

// «Di chi e'»: team, canale e runbook arrivano dai tag della risorsa. Senza nessuno dei tre la
// sezione non si mostra: un elenco di trattini non dice niente.
export function diChi(s) {
  const team = (typeof s?.owner === 'object' && s.owner?.team) || s?.team || null
  const slack = s?.slack ?? null
  const runbook = s?.runbook ?? null
  return team || slack || runbook ? { team, slack, runbook } : null
}
