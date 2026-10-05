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

// Stato del server (`overall`) → livello. `unknown` va su spento e non su ok: un controllo non letto
// non e' una buona notizia, e dipingerlo di verde direbbe il falso.
const DA_OVERALL = { down: 'crit', degraded: 'warn', up: 'ok', idle: 'off', disabled: 'off', unknown: 'off' }

export function livelloServizio(s) {
  if (LIVELLI.includes(s?.livello)) return s.livello
  return DA_OVERALL[s?.overall] ?? 'off'
}

// Livello di un segnale di "Adesso" (web/nowSignals.js usa crit/bad/warn/info): `bad` e' rosso anche
// lui, la differenza fra crit e bad la dice gia' l'ordine.
export function livelloSegnale(sig) {
  if (LIVELLI.includes(sig?.livello)) return sig.livello
  if (sig?.level === 'crit' || sig?.level === 'bad') return 'crit'
  if (sig?.level === 'warn') return 'warn'
  return 'info'
}

// A chi tocca: 'dev' (chi sviluppa) o 'ops' (DevOps). Se il server lo dice, vale quello. Altrimenti
// si deduce dal TIPO di risorsa e dalla causa: un certificato, un bucket, un database o un load
// balancer non si sistemano cambiando il codice, mentre un servizio che va in errore si'. La deriva
// da Terraform e' sempre di chi tiene l'infrastruttura, qualunque sia la risorsa.
const TIPI_OPS = new Set(['acm', 's3', 'rds', 'elasticache', 'kinesis', 'alb', 'ec2', 'cloudfront', 'dynamodb', 'sqs', 'sns'])
const CAUSE_OPS = new Set(['terraform', 'drift', 'iam', 'quota'])

export function ownerServizio(s) {
  if (s?.owner === 'dev' || s?.owner === 'ops') return s.owner
  if (s?.owner && typeof s.owner === 'object' && (s.owner.ruolo === 'dev' || s.owner.ruolo === 'ops')) return s.owner.ruolo
  if (CAUSE_OPS.has(s?.cause)) return 'ops'
  return TIPI_OPS.has(s?.type) ? 'ops' : 'dev'
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

// Il comando da copiare per cominciare a capire. Il server lo mandera' gia' composto (`comando`);
// qui si deduce solo quando la strada e' certa dai dati: il log group di una Lambda si chiama per
// convenzione AWS come la funzione, quindi `aws logs tail` funziona senza indovinare niente. Per il
// resto meglio nessun comando che uno inventato, che si copia, fallisce e insegna a non fidarsi.
export function comandoServizio(s) {
  if (typeof s?.comando === 'string' && s.comando) return s.comando
  if (s?.fix?.cmd) return s.fix.cmd
  if (s?.type === 'lambda' && s?.name) {
    const regione = s.region ? ` --region ${s.region}` : ''
    return `aws logs tail /aws/lambda/${s.name} --since 1h${regione}`
  }
  return null
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

// Storico della disponibilita' (fasce da mezz'ora, 48 nelle 24 ore). Dal server arrivera' da
// /api/history come `{ fasce: [{ livello }], percento }`. Senza, si sa solo com'e' ADESSO: l'ultima
// fascia prende lo stato attuale e le altre restano grigie, cosi' la barra non inventa un passato
// verde che nessuno ha misurato.
export function fasceDisponibilita(storico, livelloAdesso, n = 48) {
  if (Array.isArray(storico?.fasce) && storico.fasce.length) {
    return { fasce: storico.fasce.slice(-n).map((f) => (typeof f === 'string' ? f : f?.livello ?? 'off')), percento: storico.percento ?? null, dedotto: false }
  }
  const fasce = Array.from({ length: n }, () => 'off')
  fasce[n - 1] = livelloAdesso ?? 'off'
  return { fasce, percento: null, dedotto: true }
}

// Lo storico per ambiente, se il server lo manda per chiave (`{ perAmbiente: { prod: {...} } }`).
export function storicoAmbiente(storico, chiave) {
  return storico?.perAmbiente?.[chiave] ?? null
}
