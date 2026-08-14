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
      id: `svc:${s.account?.key ?? '-'}:${s.name}`,
      level: s.overall === 'down' ? 'crit' : 'warn',
      kind: 'service',
      title: nameOf(s),
      detail: [s.cause ? t(`cause.${s.cause}`) : null, cause?.summary ?? cause?.reason].filter(Boolean).join(' — '),
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
// servizio, il problema non morde più adesso — e questa pagina risponde a «devo preoccuparmi in questo
// momento», non «cosa è andato storto oggi». Restava in cima per ore, sopra i guasti veri, e la prima
// reazione di chi la legge è «ma quella poi è andata: che ci fa ancora qui?». Lo storico completo sta
// nella pagina Deploy, che è il posto dove si scava.
// Un riavvio RESPINTO resta invece sempre: non è un guasto che un rilascio successivo aggiusta, è il
// fatto che qualcuno ha provato a toccare la produzione e non ha potuto.
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
      accountKey: null, // l'anomalia porta il NOME dell'account, non la sua chiave di config
      accountLabel: a.account ?? null,
    })
  }
  return out
}

// Tutti i segnali, ordinati per gravità e — a pari gravità — dal più recente. Le righe senza data
// (gli stati in corso) vengono PRIMA delle datate del loro livello: uno stato che morde adesso batte
// un evento di sei ore fa. Puro/testabile.
// `nameOf` = come si chiama un servizio per un umano: il nome corto lo sa il client (serviceName.js),
// non il server, e passarlo tiene questa funzione pura invece di importare mezza UI.
export function buildSignals({
  services = [],
  deploys = {},
  waf = null,
  budgets = null,
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
  ]
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

// Quanti per livello, per la banda in cima. Puro/testabile.
export function countByLevel(signals = []) {
  const n = { crit: 0, bad: 0, warn: 0, info: 0 }
  for (const s of signals) if (s.level in n) n[s.level] += 1
  return n
}
