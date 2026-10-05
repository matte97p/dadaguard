// Adattatori fra quello che il server manda oggi e quello che la nuova interfaccia vuole mostrare.
//
// Perche' uno strato a parte: alcuni campi (livello, owner, comando, storico) arriveranno dal server,
// che li deduce meglio di noi perche' vede tag e configurazioni. Finche' non arrivano, la pagina non
// deve restare vuota: qui si legge il campo se c'e' e, se manca, lo si deduce dai dati che gia'
// abbiamo. Quando il server comincia a mandarlo, vince lui senza toccare le pagine.
//
// Tutto puro e testabile: sono le regole che decidono di che colore e' una riga e a chi tocca.

// I livelli dell'interfaccia: rotto, da guardare, in corso, a posto, spento. Sono cinque perche'
// cinque sono le reazioni diverse di chi legge, e i colori del tema seguono questi nomi.
export const LIVELLI = ['crit', 'warn', 'info', 'ok', 'off']
const RANGO = { crit: 0, warn: 1, info: 2, ok: 3, off: 4 }
export const rangoLivello = (l) => RANGO[l] ?? 5

// Il livello lo decide il server (server/meta/stato.js), che vede i controlli uno per uno. Qui si
// legge e basta: un servizio senza livello e' uno non ancora letto, e va su spento, non su verde.
export function livelloServizio(s) {
  return LIVELLI.includes(s?.livello) ? s.livello : 'off'
}

// Livello di un segnale di "Adesso" (web/nowSignals.js usa crit/bad/warn/info): `bad` e' rosso anche
// lui, la differenza fra crit e bad la dice gia' l'ordine.
export function livelloSegnale(sig) {
  if (LIVELLI.includes(sig?.livello)) return sig.livello
  if (sig?.level === 'crit' || sig?.level === 'bad') return 'crit'
  if (sig?.level === 'warn') return 'warn'
  return 'info'
}

// A chi tocca: 'dev' (chi sviluppa) o 'ops' (DevOps). Lo deduce il server dal check che causa il
// problema (server/meta/stato.js); senza, il servizio e' di chi sviluppa, che e' il caso comune.
export function ownerServizio(s) {
  if (s?.owner === 'dev' || s?.owner === 'ops') return s.owner
  return 'dev'
}

// Il nome del team, se il server lo sa (dal tag della risorsa). Senza, si mostra solo il ruolo.
export function teamServizio(s) {
  if (typeof s?.owner === 'object' && s.owner?.team) return s.owner.team
  return s?.team ?? null
}

// Per i segnali che non sono servizi: un budget, il WAF, un riavvio o un allarme orfano sono roba di
// chi tiene l'infrastruttura; un deploy fallito e' di chi ha scritto il codice.
const KIND_OPS = new Set(['waf', 'budget', 'anomaly', 'alarm', 'restart'])
export function ownerSegnale(sig, servizio) {
  if (sig?.owner === 'dev' || sig?.owner === 'ops') return sig.owner
  if (servizio) return ownerServizio(servizio)
  return KIND_OPS.has(sig?.kind) ? 'ops' : 'dev'
}

// Il comando da copiare per cominciare a capire. Lo compone il server, solo di lettura e solo dove
// e' certo (server/meta/stato.js): qui niente deduzioni, perche' un comando inventato si copia,
// fallisce e insegna a non fidarsi.
export function comandoServizio(s) {
  return typeof s?.comando === 'string' && s.comando ? s.comando : null
}

// Raggruppa gli account per ambiente. Il campo `environment` lo puo' dichiarare la config o dedurre
// il server; senza, ogni account e' un ambiente a se', che e' gia' la forma in cui la gente ne parla.
export function ambienti(accounts = []) {
  const m = new Map()
  for (const a of accounts) {
    const chiave = a.environment ?? a.env ?? a.key
    if (!m.has(chiave)) m.set(chiave, { key: chiave, label: a.environmentLabel ?? a.label ?? chiave, accounts: [] })
    m.get(chiave).accounts.push(a.key)
  }
  return [...m.values()]
}

// Il livello peggiore di un insieme di servizi: e' il pallino accanto all'ambiente.
export function peggiore(livelli = []) {
  let best = null
  for (const l of livelli) if (l !== 'off' && (best == null || rangoLivello(l) < rangoLivello(best))) best = l
  return best ?? 'off'
}

// Conteggi per livello, nella forma che serve alle card.
export function contaLivelli(servizi = []) {
  const out = { crit: 0, warn: 0, info: 0, ok: 0, off: 0 }
  for (const s of servizi) out[livelloServizio(s)]++
  return out
}

const FALLITE = new Set(['FAILED', 'FAULT', 'TIMED_OUT'])
export function esitoBuild(b) {
  if (b?.inProgress) return 'info'
  if (FALLITE.has(b?.status)) return 'crit'
  if (b?.status === 'STOPPED') return 'off'
  return 'ok'
}

// Le build delle ultime `ore`, appiattite su tutti gli account e dal piu' recente. Servono al
// riquadro «Oggi» e alla striscia «Cosa e' cambiato»: lo stesso dato, letto due volte.
export function buildRecenti(deploys = {}, { now = Date.now(), ore = 24, accountKeys = null } = {}) {
  const out = []
  for (const [key, acc] of Object.entries(deploys ?? {})) {
    if (accountKeys && accountKeys.length && !accountKeys.includes(key)) continue
    for (const b of acc?.builds ?? []) {
      const at = b.startedAt ? new Date(b.startedAt).getTime() : null
      if (at == null || now - at > ore * 3600_000) continue
      out.push({ ...b, accountKey: key, accountLabel: acc.label, at, esito: esitoBuild(b), aMano: b.trigger != null && b.trigger !== 'auto' })
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

export function statOggi(build = []) {
  return {
    riusciti: build.filter((b) => b.esito === 'ok').length,
    falliti: build.filter((b) => b.esito === 'crit').length,
    inCorso: build.filter((b) => b.esito === 'info').length,
    aMano: build.filter((b) => b.aMano).length,
  }
}

// Storico della disponibilita' da /api/history (server/storico.js): secchi da mezz'ora, 48 nelle
// 24 ore, per ambiente. Senza storico (server che non risponde, o in lettura) si sa solo com'e'
// ADESSO: l'ultima fascia prende lo stato attuale e le altre restano grigie, cosi' la barra non
// inventa un passato verde che nessuno ha misurato.
export function fasceDisponibilita(blocco, livelloAdesso, n = 48) {
  if (Array.isArray(blocco?.secchi) && blocco.secchi.length) {
    return { fasce: blocco.secchi.slice(-n).map((f) => f?.livello ?? 'off'), percento: blocco.disponibilita ?? null, dedotto: false }
  }
  const fasce = Array.from({ length: n }, () => 'off')
  fasce[n - 1] = livelloAdesso ?? 'off'
  return { fasce, percento: null, dedotto: true }
}

// Il blocco di storico che copre un insieme di account. Il server raggruppa per ambiente dedotto dal
// nome del conto (produzione, staging, cloudflare) e dice quali conti ci sono dentro (`conti`); la UI
// raggruppa per account scelti in alto. Si tengono i blocchi che toccano quegli account e, se sono
// piu' d'uno, si fondono: ogni secchio prende il peggiore, la disponibilita' la piu' bassa.
// `accountKeys` vuoto o null vuol dire tutta la flotta.
export function storicoPer(storico, accountKeys) {
  const blocchi = Object.values(storico?.ambienti ?? {}).filter(
    (b) => !accountKeys?.length || (b?.conti ?? []).some((c) => accountKeys.includes(c)),
  )
  if (!blocchi.length) return null
  if (blocchi.length === 1) return blocchi[0]
  const lunghezza = Math.max(...blocchi.map((b) => b.secchi?.length ?? 0))
  const secchi = Array.from({ length: lunghezza }, (_, i) => {
    const livelli = blocchi.map((b) => b.secchi?.[i]?.livello).filter(Boolean)
    return { livello: livelli.length ? livelli.reduce((x, y) => (rangoLivello(y) < rangoLivello(x) ? y : x)) : 'off' }
  })
  const disp = blocchi.map((b) => b.disponibilita).filter((x) => Number.isFinite(x))
  return { secchi, disponibilita: disp.length ? Math.min(...disp) : null }
}
