// Il motivo di una build fallita in parole che si leggono, al posto del verdetto di CodeBuild.
//
// Il verdetto (`Error while executing command: <comando>. Reason: exit status 1`) ripete il COMANDO,
// e su un buildspec con blocchi di shell da venti righe il «motivo» del quadro era lo script troncato
// (`Error while executing command: if [ -f … ]; then echo …`), che non dice niente a nessuno: visto
// l'08/10/2026 su un apply IaC morto sui lock dello state di 19 unit. La notifica dei deploy su Slack
// applicava gia' questa regola, il quadro no, e la stessa build aveva due motivi diversi.
//
// L'errore vero sta nel log della build, e NON in coda: il `finally` del buildspec echeggia centinaia
// di righe di script dopo l'apply, quindi le ultime 150 righe sono tutte script. Si cerca nello stream
// con un filtro (`PATTERN_CAUSA_BUILD`), che legge solo le righe che somigliano a un errore.
import { FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'

// Termini del filtro di CloudWatch (OR). `ERROR` e `errors occurred` prendono il riepilogo di
// terragrunt (`ERROR Run failed: 19 errors occurred`), `Error:` quella di terraform. Le righe di script
// che li contengono passano anche loro: le scarta `causaDalLog`, che guarda come comincia la riga.
// ⚠️ `Error acquiring` sta a parte: sulla riga di terraform `Error:` arriva dentro i codici colore, e il
// filtro di CloudWatch la riga dell'unit (`[network] … Error: Error acquiring the state lock`) la
// salta (misurato l'08/10/2026). Il termine intero la prende.
// `SMOKE TEST FAILED`/`Smoke test failed`: un deploy che prova la versione nuova prima di promuoverla e
// la scarta. `Version ID` e `Deployed` servono a `pubblicatoDalLog`, non alla causa: dicono se la
// versione nuova e' gia' quella in servizio quando la build muore.
export const PATTERN_CAUSA_BUILD =
  '?"Error:" ?ERROR ?"errors occurred" ?"Error acquiring" ?"fatal:" ?"npm ERR!" ?Traceback ?"SMOKE TEST FAILED" ?"Smoke test failed" ?"Version ID" ?Deployed'

// Pagine massime per stream: un apply pieno sono ~3000 righe, e il filtro ne restituisce poche decine.
const MAX_PAGINE = 5
// Quante cause si tengono in memoria. Una build fallita non cambia piu', quindi la cache non scade:
// ha solo un tetto, per non crescere a ogni build per sempre.
const MAX_CACHE = 300

const ANSI = /\x1b\[[0-9;]*m/g
// Il prefisso di terragrunt: `12:19:44.797 STDERR [network] terraform: │ `. Ne resta l'unit.
const PREFISSO_TG = /^\d\d:\d\d:\d\d\.\d+\s+(?:STDOUT|STDERR|ERROR|WARN|INFO|DEBUG)\s+(?:\[([^\]]+)\]\s+)?(?:\w+:\s+)?(?:│\s*)?/

// Una riga di log pulita: senza colori, senza il prefisso di terragrunt, con l'unit a parte.
export function pulisci(riga = '') {
  const senzaColori = String(riga).replace(ANSI, '').trim()
  const m = senzaColori.match(PREFISSO_TG)
  // Il riepilogo finale di terragrunt ripete gli errori senza prefisso, dentro la cornice: `│ Error: …`.
  if (!m) return { unit: null, testo: senzaColori.replace(/^│\s*/, '') }
  return { unit: m[1] ?? null, testo: senzaColori.slice(m[0].length).trim() }
}

// Il token dell'App GitHub finisce nell'URL del remote, e git lo stampa nei suoi errori. Si oscura
// PRIMA di qualsiasi taglio, stessa regola e stesso ordine della notifica dei deploy.
export function senzaCredenziali(t = '') {
  return String(t).replace(/:\/\/[^/@\s]*@/g, '://***@').replace(/\bgh[pousr]_[A-Za-z0-9]{6,}/g, '***')
}

// Dalle righe che il filtro ha trovato (in ordine di tempo) alla causa. `''` se nessuna e' un errore.
// Puro/testabile.
export function causaDalLog(righe = []) {
  const pulite = righe.map(pulisci)
  // Quanti errori conta terragrunt in tutto: sono le unit morte, comprese quelle saltate perche'
  // dipendevano da una morta. Va in coda alla causa, sennò «network: lock» sembra un guasto piccolo;
  // in coda e non davanti perche' il motivo si legge prima di tutto.
  const conto = pulite.map((r) => r.testo.match(/(\d+) errors occurred/)).filter(Boolean).at(-1)?.[1]
  const quanti = conto && conto !== '1' ? `, ${conto} units failed` : ''
  // I lock dello state: un altro apply teneva gli stessi state. E' il guasto da due build in parallelo,
  // e la cosa utile da dire e' QUALI unit, non il primo dei messaggi uguali.
  const lock = pulite.filter((r) => /Error acquiring the state lock/.test(r.testo))
  if (lock.length) {
    const unit = [...new Set(lock.map((r) => r.unit).filter(Boolean))]
    const quali = unit.length ? ` (${unit.slice(0, 3).join(', ')}${unit.length > 3 ? ', …' : ''})` : ''
    return `state locked by another apply${quali}${quanti}`
  }
  // Lo smoke test ha scartato la versione nuova: e' la causa, e le righe che seguono (le pagine rotte)
  // sono il dettaglio, che sta nel log. Prima di tutto il resto: le righe `ERROR` intorno sono sue.
  if (pulite.some((r) => /^smoke test failed/i.test(r.testo))) return 'smoke test failed'
  // `startsWith` e non `includes`: la riga che DEFINISCE una guardia (`echo "Error: …"`) e' echeggiata
  // da CodeBuild in ogni build, anche nelle riuscite.
  const errori = pulite.filter((r) => /^(Error:|ERROR(?=[:\s])|fatal:|npm ERR!|Traceback)/.test(r.testo))
  // Fra le righe di terraform vince l'ultima `Error:` CON l'unit, che e' quella morta: il riepilogo di
  // terragrunt ripete lo stesso testo senza dire di chi.
  const tf = errori.filter((r) => r.testo.startsWith('Error:'))
  const scelta = tf.filter((r) => r.unit).at(-1) ?? tf.at(-1)
  if (scelta) return senzaCredenziali(`${scelta.unit ? `${scelta.unit}: ` : ''}${scelta.testo.replace(/^Error:\s*/, '')}${quanti}`)
  const ultima = errori.at(-1)
  return ultima ? senzaCredenziali(conChi(ultima.testo)) : ''
}

// Chi ha parlato, davanti alla riga: `npm ERR! …` diventa `npm failed, …`, cosi' il motivo si legge
// come una frase. Un Traceback da solo non dice l'errore (sta righe sotto): resta «python crashed».
function conChi(t) {
  if (/^npm ERR!/.test(t)) return `npm failed, ${t.replace(/^npm ERR!\s*/, '')}`
  if (/^fatal:/.test(t)) return `git failed, ${t.replace(/^fatal:\s*/, '')}`
  if (/^Traceback/.test(t)) return 'python crashed'
  return t.replace(/^ERROR:?\s*/, '')
}

// La riga di wrangler senza la cornice: `╰  SUCCESS  Deployed …` diventa `Deployed …`.
const senzaCornice = (t) => t.replace(/^[\s│╰╭├─]*(?:SUCCESS\s+)?/, '')

// La versione nuova e' GIA' in servizio? Conta per una build morta dopo la pubblicazione, che non lascia
// il sito sulla versione di prima. Due modi di pubblicare con wrangler:
//   - `wrangler deploy`: la versione e' in servizio quando stampa `Current Version ID: …`;
//   - `wrangler versions upload` + `versions deploy`: la versione caricata (`Worker Version ID: …`) e'
//     in servizio solo se un `Deployed … version <id> at 100%` porta il SUO id. Un deploy che prova la
//     versione nuova e la scarta rimette al 100% quella di prima: vale l'ultima riga.
// Puro/testabile.
export function pubblicatoDalLog(righe = []) {
  let caricata = null
  let pubblicato = false
  for (const r of righe.map(pulisci)) {
    const t = senzaCornice(r.testo)
    const up = t.match(/^Worker Version ID:\s*(\S+)/)
    if (up) caricata = up[1]
    else if (/^Current Version ID:/.test(t)) pubblicato = true
    else {
      const dep = t.match(/^Deployed \S+ version (\S+) at 100%/)
      if (dep) pubblicato = !!caricata && dep[1] === caricata
    }
  }
  return pubblicato
}

// Il verdetto di CodeBuild senza il comando: resta il motivo (`exit status 1`). E' il ripiego quando
// il log non si legge o non contiene un errore riconoscibile. Puro/testabile.
export function motivoDalVerdetto(v) {
  if (!v) return v ?? null
  const m = String(v).match(/Error while executing command:[\s\S]*\.\s*Reason:\s*(.+?)\s*$/)
  return m ? `${m[1]}, cause not found` : v
}

const cache = new Map()

// La causa di UNA build fallita, letta dal suo stream, e se la versione nuova era gia' in servizio.
// `causa` vuota se non si legge o non c'e': chi chiama ripiega sul verdetto. Mai un'eccezione: e' un di
// piu', e un CloudWatch lento non deve far sparire la build dalla pagina.
export async function causaBuild(logs, build = {}) {
  const gruppo = build.logs?.groupName
  const flusso = build.logs?.streamName
  const vuota = { causa: '', pubblicato: false }
  if (!build.id || !gruppo || !flusso) return vuota
  if (cache.has(build.id)) return cache.get(build.id)
  const righe = []
  try {
    let nextToken
    for (let p = 0; p < MAX_PAGINE; p++) {
      const r = await logs.send(
        new FilterLogEventsCommand({ logGroupName: gruppo, logStreamNames: [flusso], filterPattern: PATTERN_CAUSA_BUILD, nextToken }),
      )
      righe.push(...(r.events ?? []).map((e) => e.message ?? ''))
      nextToken = r.nextToken
      if (!nextToken) break
    }
  } catch {
    return vuota
  }
  const causa = { causa: causaDalLog(righe), pubblicato: pubblicatoDalLog(righe) }
  // Solo una causa TROVATA va in cache: un vuoto puo' essere CloudWatch ancora indietro di qualche
  // secondo sulla fine della build, e in cache resterebbe vuoto per sempre.
  if (causa.causa) {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value)
    cache.set(build.id, causa)
  }
  return causa
}
