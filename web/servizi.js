// Le regole della pagina Servizi e del pannello del servizio, separate dai componenti perche' sono
// quelle che decidono cosa si legge (la frase di una riga, quali controlli, quali link) e vanno
// provate senza un browser. Tutto tollerante: i campi nuovi del server (dettaglio, comando, altrove,
// slo, budgetErrore, team, slack, runbook) possono mancare, e allora si ricade su quello che c'e'.
import { livelloServizio } from './adattatori.js'

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

// Livello di un singolo controllo. Il server lo manda (`livello`); senza, si deduce dal suo stato
// con la stessa regola dei servizi, cosi' un controllo non letto resta grigio e non diventa verde.
export const livelloControllo = (c) => livelloServizio({ livello: c?.livello, overall: c?.status })

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

// I tre filtri a chip. Contati sulla lista gia' ristretta dalla ricerca, cosi' i numeri dicono
// cosa compare premendoli.
export const CHIP = ['problemi', 'tutti', 'spenti']
export function passaChip(s, chip) {
  const l = livelloServizio(s)
  if (chip === 'problemi') return l === 'crit' || l === 'warn'
  if (chip === 'spenti') return l === 'off'
  return true
}
export function contaChip(servizi = []) {
  const out = { problemi: 0, tutti: servizi.length, spenti: 0 }
  for (const s of servizi) {
    if (passaChip(s, 'problemi')) out.problemi++
    if (passaChip(s, 'spenti')) out.spenti++
  }
  return out
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
