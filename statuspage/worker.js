// La status page pubblica di Dadaguard, come Cloudflare Worker.
//
// Vive fuori dall'infrastruttura che racconta: se il cloud dei servizi cade, questa pagina resta su
// e diventa rossa grazie alla sonda esterna. Ogni minuto (cron trigger) sonda gli indirizzi pubblici
// dei componenti e legge da Dadaguard il riepilogo `GET /api/public-status`, poi salva stato e
// storico in KV. Gli incidenti li scrive una persona da /admin, dietro Cloudflare Access.
//
// Configurazione (wrangler.example.jsonc): binding KV `STATUS`; vars `COMPONENTS` (JSON),
// `SITE_NAME`, `TZ`, `DADAGUARD_URL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`; secrets
// `DADAGUARD_CLIENT_ID` e `DADAGUARD_CLIENT_SECRET` (service token di Access verso Dadaguard).

import {
  parseComponents, decide, dayKey, addMinute, availability, validateNew, applyUpdate,
  isActive, incidentImpact, pruneItems, toRss, HISTORY_DAYS, STALE_MS,
} from './logic.js'
import { verifyAccess } from './access.js'
import { pageHtml } from './page.js'
import { adminHtml } from './admin.js'

const PROBE_TIMEOUT_MS = 8000
const INTERNO_TIMEOUT_MS = 15000

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
  const [snap, items] = await Promise.all([env.STATUS.get('snap', 'json'), env.STATUS.get('items', 'json')])
  const prev = snap ?? {}
  const list = items ?? []
  const [probes, interno] = await Promise.all([Promise.all(comps.map((c) => (c.probe ? probe(c.probe) : null))), fetchInterno(env)])

  const fails = {}
  const states = {}
  const probeOut = {}
  comps.forEach((c, i) => {
    const p = probes[i]
    fails[c.id] = p && !p.ok ? (prev.fails?.[c.id] ?? 0) + 1 : 0
    if (p) probeOut[c.id] = { ok: p.ok, ms: p.ms }
    states[c.id] = decide({ probe: p, fails: fails[c.id], interno: interno?.[c.id] ?? null, incident: incidentImpact(list, c.id, now) })
  })

  const next = {
    checkedAt: now.toISOString(),
    interno: interno !== null,
    fails,
    states,
    probes: probeOut,
    history: addMinute(prev.history, dayKey(now, env.TZ || 'UTC'), states),
  }
  await env.STATUS.put('snap', JSON.stringify(next))
  return next
}

// ---- il JSON della pagina ---------------------------------------------------------------------

// Toglie da un incidente quello che non è pubblico: chi l'ha scritto.
const pubblico = (i) => ({ ...i, updates: i.updates.map(({ by, ...u }) => u) })

function lastDays(now, tz, n = HISTORY_DAYS) {
  const out = []
  for (let k = n - 1; k >= 0; k--) out.push(dayKey(new Date(now.getTime() - k * 86400000), tz))
  return [...new Set(out)]
}

// Un giro e' dovuto se non ce n'e' mai stato uno o se l'ultimo ha piu' di 55 secondi.
export function dueForTick(checkedAt, now = Date.now()) {
  return !checkedAt || now - new Date(checkedAt).getTime() >= 55_000
}

export async function statusPayload(env, now = new Date()) {
  const comps = parseComponents(env.COMPONENTS)
  const tz = env.TZ || 'UTC'
  const [snap, items] = await Promise.all([env.STATUS.get('snap', 'json'), env.STATUS.get('items', 'json')])
  const s = snap ?? {}
  const list = items ?? []
  const days = lastDays(now, tz)
  const checkedAt = s.checkedAt ?? null
  return {
    site: env.SITE_NAME || 'Status',
    tz,
    checkedAt,
    stale: !checkedAt || now.getTime() - new Date(checkedAt).getTime() > STALE_MS,
    interno: Boolean(s.interno),
    days,
    components: comps.map((c) => {
      const hist = days.map((d) => s.history?.[d]?.[c.id] ?? null)
      return {
        id: c.id,
        name: c.name,
        sub: c.sub,
        state: s.states?.[c.id] ?? 'unknown',
        maintenance: list.some((i) => i.kind === 'maintenance' && i.components.includes(c.id) && isActive(i, now)),
        history: hist,
        uptime: availability(hist),
      }
    }),
    items: list.map(pubblico),
  }
}

// ---- HTTP -------------------------------------------------------------------------------------

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000',
}

function nonce() {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return btoa(String.fromCharCode(...b))
}

function html(body, n, extra = {}) {
  return new Response(body, {
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${n}'; style-src 'nonce-${n}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      ...extra,
    },
  })
}

const jsonRes = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra } })

async function readItems(env) {
  return (await env.STATUS.get('items', 'json')) ?? []
}

async function admin(request, env, url) {
  const by = await verifyAccess(request, env)
  if (!by) return new Response('Forbidden', { status: 403, headers: SECURITY_HEADERS })
  const comps = parseComponents(env.COMPONENTS)
  const ids = comps.map((c) => c.id)

  if (request.method === 'GET' && url.pathname === '/admin') {
    const n = nonce()
    return html(adminHtml({ nonce: n, site: env.SITE_NAME || 'Status', components: comps, user: by }), n, { 'cache-control': 'no-store' })
  }
  if (request.method === 'GET' && url.pathname === '/admin/api/items') {
    return jsonRes(await readItems(env), 200, { 'cache-control': 'no-store' })
  }
  if (request.method !== 'POST') return new Response('Not found', { status: 404, headers: SECURITY_HEADERS })
  // Solo JSON: un form di un altro sito non può mandare questo content-type senza preflight, e il
  // preflight qui non ha risposta. È la difesa CSRF, oltre al cookie di Access.
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return jsonRes({ error: 'serve application/json' }, 415)
  let body
  try {
    body = await request.json()
  } catch {
    return jsonRes({ error: 'JSON non valido' }, 400)
  }
  const now = new Date()
  const list = await readItems(env)
  try {
    if (url.pathname === '/admin/api/items') {
      const item = validateNew(body, ids, { now, by, id: crypto.randomUUID().slice(0, 8) })
      const next = pruneItems([item, ...list], now)
      await env.STATUS.put('items', JSON.stringify(next))
      console.log(JSON.stringify({ evento: 'pubblicato', id: item.id, kind: item.kind, by }))
      return jsonRes(item, 201)
    }
    const m = url.pathname.match(/^\/admin\/api\/items\/([a-z0-9-]{1,40})(\/delete)?$/)
    if (!m) return jsonRes({ error: 'rotta sconosciuta' }, 404)
    const idx = list.findIndex((i) => i.id === m[1])
    if (idx === -1) return jsonRes({ error: 'non trovato' }, 404)
    if (m[2]) {
      const next = list.filter((_, k) => k !== idx)
      await env.STATUS.put('items', JSON.stringify(next))
      console.log(JSON.stringify({ evento: 'cancellato', id: m[1], by }))
      return jsonRes({ ok: true })
    }
    const updated = applyUpdate(list[idx], body, { now, by })
    const next = list.map((i, k) => (k === idx ? updated : i))
    await env.STATUS.put('items', JSON.stringify(next))
    console.log(JSON.stringify({ evento: 'aggiornato', id: m[1], status: body.status, by }))
    return jsonRes(updated)
  } catch (err) {
    return jsonRes({ error: err.message }, 400)
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return admin(request, env, url)
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: SECURITY_HEADERS })

    if (url.pathname === '/') {
      const n = nonce()
      return html(pageHtml({ nonce: n, site: env.SITE_NAME || 'Status' }), n, { 'cache-control': 'public, max-age=60' })
    }
    if (url.pathname === '/api/status.json') {
      const payload = await statusPayload(env)
      // Riserva del cron: se l'ultimo giro e' piu' vecchio di un minuto, lo fa partire questa visita,
      // dopo aver risposto. Il cron resta il motore; questa via copre un cron che non parte, e il
      // limite di un minuto evita che piu' visite contino lo stesso minuto due volte.
      if (ctx && dueForTick(payload.checkedAt)) ctx.waitUntil(tick(env).catch((err) => console.error(JSON.stringify({ evento: 'giro fallito', err: err.message }))))
      return jsonRes(payload, 200, { 'cache-control': 'public, max-age=30', 'access-control-allow-origin': '*' })
    }
    if (url.pathname === '/feed.xml') {
      const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'it'
      const items = (await readItems(env)).map(pubblico)
      const body = toRss(items, { title: `${env.SITE_NAME || 'Status'} status`, link: `${url.origin}/`, lang })
      return new Response(body, { headers: { ...SECURITY_HEADERS, 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=60' } })
    }
    if (url.pathname === '/health') return jsonRes({ ok: true })
    return new Response('Not found', { status: 404, headers: SECURITY_HEADERS })
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env).catch((err) => console.error(JSON.stringify({ evento: 'giro fallito', err: err.message }))))
  },
}
