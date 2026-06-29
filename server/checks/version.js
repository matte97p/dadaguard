// Segnale #2 — versione attesa: gira la versione che mi aspetto?
// Si applica se il servizio dichiara `expectedVersion`. Legge la versione "reale"
// dal payload JSON di `healthUrl` (campo `versionField`, default "version",
// supporta path con punto es. "info.version"). Confronto normalizzato (ignora "v"
// iniziale e spazi). up = match, degraded = mismatch, unknown = non leggibile.
//
// Nota: la fonte oggi è il /health HTTP. Per Lambda/ECS (versione dietro alias o
// tag immagine) si aggiungerà qui senza toccare il resto.
const TIMEOUT_MS = 5000

export const key = 'version'

const norm = (v) => String(v).trim().replace(/^v/i, '')

export async function run(service) {
  const expected = service.expectedVersion
  if (!expected) return null // segnale non applicabile

  if (!service.healthUrl) {
    return { key, status: 'unknown', reason: 'nessuna fonte versione (manca healthUrl)' }
  }

  const field = service.versionField || 'version'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(service.healthUrl, { signal: controller.signal })
    const body = await res.json()
    const actual = field.split('.').reduce((o, k) => (o == null ? o : o[k]), body)

    if (actual == null) {
      return { key, status: 'unknown', reason: `campo '${field}' assente nel payload` }
    }
    if (norm(actual) === norm(expected)) {
      return { key, status: 'up', summary: `v${norm(actual)}` }
    }
    return { key, status: 'degraded', summary: `gira ${actual}, atteso ${expected}` }
  } catch (err) {
    return {
      key,
      status: 'unknown',
      reason: err.name === 'AbortError' ? 'timeout' : 'health non leggibile come JSON',
    }
  } finally {
    clearTimeout(timer)
  }
}
