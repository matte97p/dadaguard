// "Adesso" — cosa è cambiato o morde nella finestra corrente, da tutte le fonti insieme.
//
// Perché esiste questa pagina: la domanda «devo preoccuparmi in questo momento?» attraversava quattro
// viste. Un servizio degradato sta nella flotta, un hotfix fuori dalla CI nei Deploy, le richieste
// fermate dal WAF in Sicurezza, un budget sforato nei Costi. Nessuna delle quattro è sbagliata — sono
// il posto dove si SCAVA — ma per rispondere a quella domanda le dovevi aprire tutte e a memoria.
//
// Qui non c'è nessun dato nuovo: si legge quello che le pagine già leggono e si tiene solo ciò che
// (a) è cambiato dentro la finestra, oppure (b) è uno stato che morde adesso. Ogni riga porta il link
// alla pagina che ne sa di più: questa vista non sostituisce niente, ci manda.
//
// Tutto puro e testabile: è la funzione che decide cosa vede un umano quando apre la dashboard, e le
// soglie qui dentro sono decisioni di prodotto, non dettagli.

import { compactBuildReason } from './format.js'
import { kpiAndamento, livelloErrori } from '../shared/serviziSerie.js'
import { unisciConti, tabellaServizi } from '../shared/spesaSerie.js'

const FAILED = new Set(['FAILED', 'FAULT', 'TIMED_OUT'])

// Sopra questa cifra un'anomalia di costo non è una curiosità. Sotto, resta in elenco come `info`:
// dirla piano è diverso dal non dirla.
const ANOMALY_LOUD = 50

// Ordine dei livelli: è l'ordine in cui si legge la pagina.
const LEVEL_RANK = { crit: 0, bad: 1, warn: 2, info: 3 }

const ms = (v) => (v ? new Date(v).getTime() : null)

// Dentro la finestra? Un evento senza data si TIENE: scartarlo significherebbe nascondere un fatto
// perché non sappiamo quando è successo. Puro/testabile.
export function inWindow(when, { now, hours }) {
  const at = ms(when)
  if (at == null) return true
  return now - at <= hours * 3600_000
}

// Un servizio giù o degradato è uno stato, non un evento: vale ADESSO, indipendentemente dalla
// finestra. Il "perché" lo dice già il server (`cause` + il check colpevole), non lo si ricalcola qui.
function serviceSignals(services = [], t, nameOf) {
  const out = []
  for (const s of services) {
    if (s?.overall !== 'down' && s?.overall !== 'degraded') continue
    const cause = s.cause ? s.checks?.[s.cause] : null
    out.push({
      // L'identità della RISORSA, non il nome: due risorse omonime dello stesso account (una ECS e il
      // suo ALB) davano due segnali con lo stesso id, che è la chiave React della riga in pagina, e
      // quando uno dei due rientrava restava una riga rossa appesa sulla pagina dei guasti.
      id: `svc:${s.account?.key ?? '-'}:${s.resourceId ?? s.name}`,
      level: s.overall === 'down' ? 'crit' : 'warn',
      kind: 'service',
      title: nameOf(s),
      detail: [s.cause ? t(`cause.${s.cause}`) : null, cause?.summary ?? cause?.reason].filter(Boolean).join(': '),
      when: null, // stato in corso: "quanto fa" non si applica, e inventarlo sarebbe peggio
      to: '/servizi',
      accountKey: s.account?.key ?? null,
      accountLabel: s.account?.label ?? null,
    })
  }
  return out
}

// L'istante dell'ultima build RIUSCITA, per account e servizio. Pura/testabile.
export function lastSuccessBySvc(deploys = {}) {
  const map = new Map()
  for (const [key, acc] of Object.entries(deploys)) {
    for (const b of acc?.builds ?? []) {
      if (b.inProgress || FAILED.has(b.status) || b.status === 'STOPPED') continue
      const at = ms(b.endedAt ?? b.startedAt)
      const k = `${key}/${b.service ?? ''}`
      if (at != null && (map.get(k) ?? -Infinity) < at) map.set(k, at)
    }
  }
  return map
}

// Deploy: si tengono i FALLITI, quelli IN CORSO e tutte le azioni fatte a mano (hotfix e riavvii).
// I rilasci automatici riusciti no: sono la normalità, e riempirebbero la pagina di righe verdi
// facendo scorrere via le tre che contano.
//
// E un fallimento SUPERATO non ci sta: se dopo quella build ne è passata una riuscita per lo stesso
// servizio, il problema non morde più adesso, e questa pagina risponde a «devo preoccuparmi in questo
// momento», non «cosa è andato storto oggi». Restava in cima per ore, sopra i guasti veri, e la prima
// reazione di chi la legge è «ma quella poi è andata: che ci fa ancora qui?». Lo storico completo sta
// nella pagina Deploy, che è il posto dove si scava.
// Un riavvio RESPINTO resta invece sempre: non è un guasto che un rilascio successivo aggiusta, è il
// fatto che qualcuno ha provato a toccare la produzione e non ha potuto.
function duratePerServizio(builds = [], servizio) {
  return (builds ?? [])
    .filter((x) => x.service === servizio && x.kind !== 'restart' && Number.isFinite(x.durationMs))
    .sort((a, c) => ms(a.startedAt) - ms(c.startedAt))
    .slice(-12)
    .map((x) => Math.round(x.durationMs / 1000))
}

function deploySignals(deploys = {}, opts, t) {
  const riuscite = lastSuccessBySvc(deploys)
  const out = []
  for (const [key, acc] of Object.entries(deploys)) {
    for (const b of acc?.builds ?? []) {
      if (!inWindow(b.startedAt, opts)) continue
      const restart = b.kind === 'restart'
      const hotfix = b.trigger === 'hotfix'
      const failed = FAILED.has(b.status)
      const superata = failed && !restart && (riuscite.get(`${key}/${b.service ?? ''}`) ?? -Infinity) > (ms(b.startedAt) ?? 0)
      if (superata) continue
      let level = null
      let detail = null
      if (failed && restart) {
        // Un riavvio respinto non è «una build fallita»: non c'era nessuna build. La parola sbagliata
        // qui manda a cercare un errore di compilazione che non esiste.
        level = 'bad'
        detail = [t('now.restartDenied', { who: b.forcedBy ?? '—' }), compactBuildReason(b.failReason)].filter(Boolean).join(': ')
      } else if (failed) {
        level = 'bad'
        detail = [b.failPhase ? t('now.deployFailedIn', { phase: b.failPhase }) : t('now.deployFailed'), compactBuildReason(b.failReason)]
          .filter(Boolean)
          .join(': ')
      } else if (hotfix) {
        level = 'warn'
        detail = t('now.hotfix', { who: b.forcedBy ?? '—' })
      } else if (restart) {
        // Solo i riavvii di una PERSONA sono una notizia. Nei dati veri quasi tutti li fa CodeBuild (è il
        // deploy che chiama `update-service`) o la lambda che sincronizza i segreti: metterli qui è
        // raccontare due volte lo stesso rilascio, e spingere giù i fatti veri.
        if (b.actorKind != null && b.actorKind !== 'human') continue
        level = 'info'
        detail = t('now.restart', { who: b.forcedBy ?? '—' })
      } else if (b.inProgress) {
        level = 'info'
        detail = t('now.deployRunning')
      }
      if (!level) continue
      out.push({
        id: `dep:${b.id ?? `${key}:${b.service}:${b.startedAt}`}`,
        level,
        kind: restart ? 'restart' : 'deploy',
        title: b.service ?? '—',
        detail,
        when: b.startedAt ?? null,
        // Il messaggio integrale non si butta: sta nel `title` della riga (e nella pagina Deploy). Chi
        // vuole il comando che è morto lo trova; chi legge l'elenco non se lo trova addosso.
        full: b.failReason ?? null,
        to: `/deploy?service=${encodeURIComponent(b.service ?? '')}`,
        accountKey: key,
        accountLabel: acc?.label ?? key,
        // Le durate delle ultime build di quel servizio, dalla piu' vecchia: si vede se e' una build
        // storta o un servizio che rilascia male da giorni. I riavvii non hanno una build da misurare.
        serie: restart ? null : duratePerServizio(acc?.builds, b.service),
      })
    }
  }
  return out
}

// WAF: una zona che ha fermato traffico. Non si guarda il volume in assoluto — poche richieste
// fermate su un percorso applicativo sono peggio di molte fermate su un tentativo di scansione — per
// questo il livello è sempre `warn` e il numero sta nel dettaglio, dove si legge insieme alla regola.
function wafSignals(waf, t) {
  const out = []
  for (const z of waf?.zones ?? []) {
    if (!z || z.error || !(z.blocked > 0)) continue
    const top = (z.rules ?? []).find((r) => r.blocking)
    out.push({
      id: `waf:${z.zoneId ?? z.zone}`,
      level: 'warn',
      kind: 'waf',
      title: z.zone,
      detail: [t('now.wafBlocked', { n: z.blocked.toLocaleString() }), top?.paths?.length ? top.paths.join(' · ') : null].filter(Boolean).join(' — '),
      when: null, // aggregato sulla finestra: non c'è un istante da mostrare
      to: '/sicurezza',
      accountKey: 'cloudflare',
      accountLabel: 'Cloudflare',
    })
  }
  return out
}

// Budget: sforati e "sforerà". Quelli sotto controllo non compaiono — un budget al 30% non è una
// notizia, e la pagina Spesa li mostra tutti quando la domanda è quella.
function budgetSignals(budgets, t) {
  const out = []
  for (const [key, acc] of Object.entries(budgets?.accounts ?? {})) {
    for (const b of acc?.budgets ?? []) {
      if (b.level !== 'over' && b.level !== 'willOver') continue
      out.push({
        id: `bud:${key}:${b.name}`,
        level: b.level === 'over' ? 'bad' : 'warn',
        kind: 'budget',
        title: b.name,
        detail:
          b.level === 'over'
            ? t('now.budgetOver', { pct: b.actualPct ?? '?' })
            : t('now.budgetWillOver', { pct: b.forecastPct ?? '?' }),
        when: null,
        to: '/spesa',
        accountKey: key,
        accountLabel: acc?.label ?? key,
      })
    }
  }
  for (const a of budgets?.anomalies ?? []) {
    out.push({
      id: `anom:${a.id}`,
      // Già marcata come attesa da qualcuno: resta in elenco (è successa) ma smette di allarmare.
      level: a.feedback === 'YES' ? 'info' : (a.impact ?? 0) >= ANOMALY_LOUD ? 'warn' : 'info',
      kind: 'anomaly',
      title: a.service ?? t('now.anomaly'),
      detail: t('now.anomalyDetail', { amount: Math.round(a.impact ?? 0), pct: a.impactPct ?? '?' }),
      when: a.start ?? null,
      to: '/spesa',
      // La chiave la mette il server dall'ID dell'account; null = account fuori dalla config, e allora
      // l'anomalia resta visibile sotto ogni filtro piuttosto che sparire.
      accountKey: a.accountKey ?? null,
      accountLabel: a.account ?? null,
    })
  }
  return out
}

// Gli allarmi CloudWatch che stanno urlando e che nessun servizio riconosce come suoi.
//
// ⚠️ Sono l'unico posto in cui compaiono. La flotta li mostra sulla card del servizio, correlandoli
// per DIMENSIONE, e un allarme nato da un metric filter su un log group non ne ha nessuna: la sua
// metrica conta righe di log, non lo stato di una risorsa. Fino al 01/09/2026 venivano scaricati e
// buttati via, cioe' suonavano e non li vedeva nessuno.
//
// Livello `bad` e non `crit`: sta suonando adesso, ma non sappiamo di cosa — un servizio giu' e' una
// notizia peggiore, e metterli sullo stesso gradino toglierebbe la prima riga a chi la merita.
// `to: null`: non c'e' una pagina che ne sappia di piu', e mandare a una vista che non li elenca e'
// peggio che non offrire il link.
function alarmSignals(alarmi = [], t) {
  return (alarmi ?? []).map((a) => ({
    id: `alarm:${a.account ?? '-'}:${a.nome}`,
    level: 'bad',
    kind: 'alarm',
    title: a.nome ?? t('now.alarm'),
    detail: a.motivo ?? t('now.alarmDetail'),
    when: a.da ?? null,
    to: null,
    accountKey: a.account ?? null,
    accountLabel: a.accountLabel ?? null,
  }))
}

// Tutti i segnali, ordinati per gravità e — a pari gravità — dal più recente. Le righe senza data
// (gli stati in corso) vengono PRIMA delle datate del loro livello: uno stato che morde adesso batte
// un evento di sei ore fa. Puro/testabile.
// `nameOf` = come si chiama un servizio per un umano: il nome corto lo sa il client (serviceName.js),
// non il server, e passarlo tiene questa funzione pura invece di importare mezza UI.
// Le build PIU' LENTE DEL SOLITO (server/tempiDeploy.js, `lenta`): l'ultima build riuscita di un
// servizio molto sopra le sue precedenti. Giallo da guardare, non un guasto: il servizio resta verde,
// perche' gira, ma il prossimo rilascio (o un hotfix urgente) ci mettera' di piu'. Solo se quella
// build e' dentro la finestra: una lentezza di tre giorni fa che nessuno ha rifatto non e' «adesso».
// Di chi e': una coda lunga e' CodeBuild senza macchine (DevOps), il resto e' di chi sviluppa.
function lenteSignals(tempi, opts, t) {
  const out = []
  for (const r of tempi?.righe ?? []) {
    const l = r.lenta
    if (!l || !inWindow(l.quando, opts)) continue
    out.push({
      id: `lenta:${r.account}:${r.servizio}:${l.build ?? ''}`,
      level: 'warn',
      kind: 'slow-build',
      owner: l.fase === 'coda' ? 'ops' : 'dev',
      title: r.servizio,
      detail: t(l.fase ? 'now.slowBuildIn' : 'now.slowBuild', { d: minuti(l.durationMs), solito: minuti(l.p50), fase: l.fase ? t(`tempi.fase.${l.fase}`) : '' }),
      when: l.quando,
      to: `/deploy?vista=andamento&service=${encodeURIComponent(r.servizio)}`,
      accountKey: r.account,
      accountLabel: r.accountLabel ?? null,
    })
  }
  return out
}
const minuti = (v) => (Number.isFinite(v) ? `${Math.max(1, Math.round(v / 60_000))} min` : '?')

// I segnali delle viste «Andamento», per «Da sistemare»: solo quello che e' successo nelle ULTIME
// 24 ORE (l'ultima ora per la velocita' dei servizi), perche' la home risponde a «cosa guardo adesso».
// Ognuno porta alla sua vista. Le fonti arrivano dalle stesse rotte delle pagine e dalle loro cache;
// una che manca (permesso, errore) toglie i suoi segnali e basta.

// Cron: fallite e saltate nelle fasce che finiscono nelle ultime 24 ore (`/api/runs/storico`). Una
// fallita e' rossa, una saltata gialla: un cron che non e' partito non ha fatto il suo lavoro, ma non
// ha nemmeno rotto niente.
function cronSignals(storico, { now }, t) {
  if (!storico?.crons?.length || !storico.passoMs) return []
  const da = now - 24 * 3_600_000
  const dentro = (i) => storico.inizio + (i + 1) * storico.passoMs > da
  const out = []
  for (const c of storico.crons) {
    let fallite = 0
    let saltate = 0
    let ultima = null
    ;(c.corse ?? []).forEach((_, i) => {
      if (!dentro(i)) return
      const f = c.fallite?.[i] ?? 0
      const sa = c.saltate?.[i] ?? 0
      fallite += f
      saltate += sa
      if (f || sa) ultima = storico.inizio + i * storico.passoMs
    })
    if (!fallite && !saltate) continue
    out.push({
      id: `cron:${c.k}`,
      level: fallite ? 'bad' : 'warn',
      // L'andamento della settimana, fascia per fascia: un cron che fallisce da giorni e uno che e'
      // caduto stanotte si distinguono a colpo d'occhio.
      serie: (c.corse ?? []).map((_, i) => (fallite ? c.fallite?.[i] ?? 0 : c.saltate?.[i] ?? 0)),
      kind: 'cron',
      title: c.nome,
      detail: [fallite ? t('now.cronFallito', { n: fallite }) : null, saltate ? t('now.cronSaltato', { n: saltate }) : null].filter(Boolean).join(' · '),
      when: ultima,
      to: `/cron?cron=${encodeURIComponent(c.k)}`,
      accountKey: c.account ?? null,
      accountLabel: storico.account?.[c.account]?.label ?? null,
    })
  }
  return out
}

// Servizi web (`/api/servizi/andamento`, 24 ore): errori sopra soglia nelle 24 ore (le soglie della
// vista: rosso dal 5%, giallo dall'1%), oppure l'ULTIMA ORA molto piu' lenta del resto della giornata
// (il doppio, e almeno 200 ms in piu': sotto e' rumore che nessuno sente).
function serviziSignals(andamento, t) {
  const servizi = andamento?.servizi ?? []
  if (!servizi.length || !andamento.passoMs) return []
  const ultimi = Math.max(1, Math.round(3_600_000 / andamento.passoMs))
  const fetta = (s, da, a) => ({ ...s, richieste: s.richieste.slice(da, a), errori: s.errori.slice(da, a), p50: s.p50.slice(da, a), p90: s.p90.slice(da, a) })
  const out = []
  for (const s of servizi) {
    const giorno = kpiAndamento([s])
    const ora = kpiAndamento([fetta(s, -ultimi)])
    const prima = kpiAndamento([fetta(s, 0, -ultimi)])
    const errori = livelloErrori(giorno.tasso)
    const lento = Number.isFinite(ora.p50) && Number.isFinite(prima.p50) && ora.p50 > prima.p50 * 2 && ora.p50 - prima.p50 >= 200
    if (!errori && !lento) continue
    out.push({
      id: `web:${s.k}`,
      level: errori === 'crit' ? 'bad' : 'warn',
      // Gli errori ora per ora se il problema sono gli errori, se no il tempo di risposta di solito.
      serie: errori ? s.errori : s.p50.map((v) => (v == null ? null : v)),
      kind: 'web',
      title: s.servizio,
      detail: [
        errori ? t('now.webErrori', { pct: (Math.round(giorno.tasso * 1000) / 10).toString().replace('.', ','), n: giorno.errori }) : null,
        lento ? t('now.webLento', { ora: Math.round(ora.p50), solito: Math.round(prima.p50) }) : null,
      ]
        .filter(Boolean)
        .join(' · '),
      when: null,
      to: '/servizi',
      accountKey: s.account ?? null,
      accountLabel: andamento.account?.[s.account]?.label ?? null,
    })
  }
  return out
}

// Spesa (`/api/costs/daily`): un servizio che in sette giorni costa almeno un terzo in piu' dei sette
// prima, e almeno 50 $ in piu' (sotto, la percentuale grande di un servizio da pochi dollari e' rumore).
// E' di chi tiene l'infrastruttura. A listino, come la tabella della vista: i crediti non si dividono
// per servizio.
function spesaSignals(daily, t) {
  const conti = Object.values(daily ?? {}).filter((c) => c && !c.error && c.giorni?.length)
  if (!conti.length) return []
  const out = []
  const uniti = unisciConti(conti)
  const valori = new Map((uniti.servizi ?? []).map((x) => [x.servizio, x.valori]))
  for (const r of tabellaServizi(uniti)) {
    const w = r.settimana
    if (!w || w.prima == null || w.variazione == null) continue
    if (w.variazione < 1 / 3 || w.ultimi - w.prima < 50) continue
    out.push({
      id: `spesa:${r.servizio}`,
      level: 'warn',
      // Le ultime due settimane giorno per giorno: la salita si vede.
      serie: (valori.get(r.servizio) ?? []).slice(-15, -1),
      kind: 'spesa',
      owner: 'ops',
      title: r.servizio,
      detail: t('now.spesaCresce', { pct: Math.round(w.variazione * 100), ora: Math.round(w.ultimi), prima: Math.round(w.prima) }),
      when: null,
      to: '/spesa?tab=andamento',
      accountKey: null,
      accountLabel: null,
    })
  }
  return out
}

export function buildSignals({
  services = [],
  deploys = {},
  waf = null,
  budgets = null,
  alarmi = null,
  tempi = null,
  cron = null,
  web = null,
  spesa = null,
  hours = 24,
  now = Date.now(),
  t = (k) => k,
  nameOf = (s) => s?.name,
} = {}) {
  const opts = { now, hours }
  // `?? []` e non solo il default del parametro: una fonte che ha FALLITO arriva qui come `null`
  // esplicito (lo stato del fetch parte da null), e il default dei parametri copre solo `undefined`.
  // Senza questa riga una chiamata andata male non lasciava la pagina incompleta: la spegneva.
  const all = [
    ...serviceSignals(services ?? [], t, nameOf),
    ...deploySignals(deploys ?? {}, opts, t),
    ...wafSignals(waf, t),
    ...budgetSignals(budgets, t),
    ...alarmSignals(alarmi ?? [], t),
    ...lenteSignals(tempi, opts, t),
    ...cronSignals(cron, opts, t),
    ...serviziSignals(web, t),
    ...spesaSignals(spesa, t),
  ].map((s) => (s.kind === 'service' && !s.serie ? { ...s, serie: serieServizio(s, services, web) } : s))
  return all.sort((a, b) => {
    const r = (LEVEL_RANK[a.level] ?? 9) - (LEVEL_RANK[b.level] ?? 9)
    if (r !== 0) return r
    const at = ms(a.when)
    const bt = ms(b.when)
    if (at == null && bt == null) return 0
    if (at == null) return -1
    if (bt == null) return 1
    return bt - at
  })
}

// L'andamento di un servizio rotto o da guardare, da dati che la home ha gia': lo spark del runtime
// quando c'e' (i Worker di Cloudflare lo portano), altrimenti il tempo di risposta ora per ora del suo
// load balancer dalla vista Andamento dei servizi web. Senza nessuno dei due, niente: meglio una riga
// senza andamento che un andamento inventato.
function serieServizio(sig, services = [], web = null) {
  const s = (services ?? []).find((x) => `svc:${x.account?.key ?? '-'}:${x.resourceId ?? x.name}` === sig.id)
  const spark = Object.values(s?.checks ?? {})
    .flatMap((c) => c?.metrics ?? [])
    .find((m) => Array.isArray(m?.spark) && m.spark.length > 1)?.spark
  if (spark) return spark
  const alb = (web?.servizi ?? []).find((w) => w.account === sig.accountKey && (w.servizio === s?.name || w.servizio === sig.title))
  return alb?.p50?.some((v) => v != null) ? alb.p50 : null
}

// L'AREA di un segnale, per le tessere di «Solo da sistemare»: dove guardare, nelle parole delle
// pagine. Un segnale di servizio va con il suo tipo solo quando e' un servizio web; il resto e' «servizi».
export const AREE = ['servizi', 'deploy', 'cron', 'web', 'spesa', 'sicurezza']
export function areaDi(sig) {
  const k = sig?.kind
  if (k === 'deploy' || k === 'slow-build' || k === 'restart') return 'deploy'
  if (k === 'cron') return 'cron'
  if (k === 'web') return 'web'
  if (k === 'spesa' || k === 'budget' || k === 'anomaly') return 'spesa'
  if (k === 'waf' || k === 'alarm') return 'sicurezza'
  return 'servizi'
}

// Quanti per area e per livello, nell'ordine delle aree. Puro/testabile.
export function contaPerArea(righe = []) {
  const out = Object.fromEntries(AREE.map((a) => [a, { crit: 0, warn: 0 }]))
  for (const r of righe) {
    const a = out[areaDi(r)]
    if (r.livello === 'crit') a.crit++
    else if (r.livello === 'warn') a.warn++
  }
  return out
}

// Quanti per livello, per la banda in cima. Puro/testabile.
export function countByLevel(signals = []) {
  const n = { crit: 0, bad: 0, warn: 0, info: 0 }
  for (const s of signals) if (s.level in n) n[s.level] += 1
  return n
}
