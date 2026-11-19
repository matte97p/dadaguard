// The status engine of Dadaguard, as a Cloudflare Worker.
//
// It lives outside the infrastructure it describes: if the cloud of the services goes down, the
// engine keeps running and its external probe sees it. Every minute (cron trigger) it probes the
// public URL of each component and reads the summary `GET /api/public-status` from Dadaguard, decides
// the state of each component, pushes the changes to Atlassian Statuspage (mirror.js) and saves the
// state in KV. The public page, its incidents and its maintenance live on Statuspage. The only HTTP
// path is /health, for a watchdog.
//
// Configuration (build-config.mjs): KV binding `STATUS`; vars `COMPONENTS` (JSON), `DADAGUARD_URL`,
// `ATLASSIAN_PAGE_ID`, `ATLASSIAN_COMPONENTS`; secrets `DADAGUARD_CLIENT_ID` and
// `DADAGUARD_CLIENT_SECRET` (Access service token towards Dadaguard), `ATLASSIAN_API_KEY`.

import { parseComponents, decide, STALE_MS } from './logic.js'
import { parseMirrorMap, mirrorPlan, mirrorEnabled, pushMirror } from './mirror.js'

const PROBE_TIMEOUT_MS = 8000
const INTERNO_TIMEOUT_MS = 15000

// KV key where an older version's 90-day history is moved once, out of the state read every minute.
// Nothing reads it: delete it when you no longer need it (see README).
export const HISTORY_ARCHIVE_KEY = 'history-archive'

// ---- il giro di ogni minuto -------------------------------------------------------------------

async function probe(url) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': 'dadaguard-statuspage-probe' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    // Un 401 o un 404 dicono che il servizio risponde: per una sonda di raggiungibilità conta
    // solo il 5xx (o nessuna risposta).
    return { ok: res.status < 500, ms: Date.now() - t0, status: res.status }
  } catch {
    return { ok: false, ms: Date.now() - t0, status: 0 }
  }
}

async function fetchInterno(env) {
  if (!env.DADAGUARD_URL) return null
  try {
    const res = await fetch(new URL('/api/public-status', env.DADAGUARD_URL), {
      headers: {
        'CF-Access-Client-Id': env.DADAGUARD_CLIENT_ID ?? '',
        'CF-Access-Client-Secret': env.DADAGUARD_CLIENT_SECRET ?? '',
        accept: 'application/json',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(INTERNO_TIMEOUT_MS),
    })
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) return null
    const body = await res.json()
    const out = {}
    for (const c of body?.components ?? []) if (typeof c?.id === 'string' && typeof c?.state === 'string') out[c.id] = c.state
    return out
  } catch {
    return null
  }
}

export async function tick(env, now = new Date()) {
  const comps = parseComponents(env.COMPONENTS)
  const prev = (await env.STATUS.get('snap', 'json')) ?? {}
  const [probes, interno] = await Promise.all([Promise.all(comps.map((c) => (c.probe ? probe(c.probe) : null))), fetchInterno(env)])

  const fails = {}
  const states = {}
  const probeOut = {}
  comps.forEach((c, i) => {
    const p = probes[i]
    fails[c.id] = p && !p.ok ? (prev.fails?.[c.id] ?? 0) + 1 : 0
    if (p) probeOut[c.id] = { ok: p.ok, ms: p.ms }
    states[c.id] = decide({ probe: p, fails: fails[c.id], interno: interno?.[c.id] ?? null })
  })

  // Copia su Atlassian Statuspage, se configurata: solo i componenti cambiati dall'ultimo push
  // accettato, che resta nello snapshot (nessuna scrittura KV in più).
  let mirrored = prev.mirrored ?? {}
  // Da quando la copia su Statuspage non riesce: /health lo usa per dare 503 (vedi MIRROR_FAIL_MS).
  let mirrorFailingSince = prev.mirrorFailingSince ?? null
  if (mirrorEnabled(env)) {
    const map = parseMirrorMap(env.ATLASSIAN_COMPONENTS, comps.map((c) => c.id))
    const plan = mirrorPlan({ states, map, sent: mirrored })
    const r = await pushMirror(env, plan, mirrored)
    mirrored = r.sent
    mirrorFailingSince = r.ok ? null : mirrorFailingSince ?? now.toISOString()
  } else mirrorFailingSince = null

  // An older version kept a 90-day history inside the state. Move it once to its own key instead of
  // dropping it, so an upgrade never loses data; the archive is written before the state, so a failed
  // write leaves the history where it was and the next tick tries again.
  if (prev.history && typeof prev.history === 'object') await env.STATUS.put(HISTORY_ARCHIVE_KEY, JSON.stringify(prev.history))

  const next = {
    checkedAt: now.toISOString(),
    interno: interno !== null,
    fails,
    states,
    probes: probeOut,
    mirrored,
    mirrorFailingSince,
  }
  await env.STATUS.put('snap', JSON.stringify(next))
  return next
}

// I dati sono vecchi se non c'e' mai stato un giro o se l'ultimo ha piu' di STALE_MS.
export function dueForStale(checkedAt, now = Date.now()) {
  return !checkedAt || now - new Date(checkedAt).getTime() > STALE_MS
}

// La copia su un vendor fallisce da troppo: un giro saltato si riprova da solo, cinque minuti di fila no.
export const MIRROR_FAIL_MS = 5 * 60 * 1000
export function mirrorFailing(since, now = Date.now()) {
  return Boolean(since) && now - new Date(since).getTime() > MIRROR_FAIL_MS
}

// ---- HTTP -------------------------------------------------------------------------------------

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000',
}

const jsonRes = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra } })

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname !== '/health') return new Response('Not found', { status: 404, headers: SECURITY_HEADERS })
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: SECURITY_HEADERS })
    // Health = the minute tick is alive. The public page is served elsewhere (for example on Atlassian
    // Statuspage, fed by mirror.js), so nobody visits this Worker and the vendor page keeps the last
    // state it got if the cron stops. This answer lets an external watchdog notice: 503 when the last
    // tick is older than STALE_MS. It never starts a tick itself, otherwise the watchdog would hide the
    // problem it is there to see.
    const snap = await env.STATUS.get('snap', 'json')
    const checkedAt = snap?.checkedAt ?? null
    const mirrorFailingSince = snap?.mirrorFailingSince ?? null
    // 503 anche quando il giro gira ma il vendor rifiuta gli stati da piu' di 5 minuti: altrimenti
    // la pagina pubblica resterebbe sull'ultimo stato accettato mentre il watchdog vede verde.
    const ok = !dueForStale(checkedAt) && !mirrorFailing(mirrorFailingSince)
    return jsonRes({ ok, checkedAt, mirrorFailingSince }, ok ? 200 : 503, { 'cache-control': 'no-store' })
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env).catch((err) => console.error(JSON.stringify({ evento: 'giro fallito', err: err.message }))))
  },
}
