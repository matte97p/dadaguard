import { log } from '../log.js'
import { stateClass } from './diff.js'
import { envTag, causeLabel } from './slack.js'

// I TICKET degli allarmi su Linear. Slack dice «adesso è giù» e scorre via; un ticket resta, ha un
// proprietario e uno stato, ed è il posto dove si scrive perché è successo. Quindi un ticket solo per
// i rossi VERI: un servizio confermato giù (`down`), già annunciato su Slack, fuori da staging. I gialli
// restano in chat: un ticket per ogni sfarfallio insegna a chiuderli senza leggerli.
//
// ⚠️ Non segue le TRANSIZIONI, segue lo STATO. A ogni giro si confronta l'insieme dei rossi annunciati
// con l'insieme dei ticket aperti su Linear: si apre quello che manca, si chiude quello rientrato.
// Le transizioni non bastano per due ragioni viste dal vivo:
//  · il file di stato su ECS è effimero, quindi dopo un deploy il rientro di un allarme aperto prima
//    non viene annunciato (è un «rientro orfano», vedi diff.js) e un ticket aspetterebbe per sempre;
//  · se Linear non risponde al giro dell'allarme, la transizione è persa; lo stato no, e il giro
//    dopo riprova.
// La memoria di QUALE ticket è di quale risorsa sta su Linear stesso, in un allegato con un URL per
// risorsa: niente da ricordare qui, e niente da perdere a un riavvio.
//
// Configurazione (tutta opzionale: senza chiave non parte e non chiama nessuno):
//   DADAGUARD_LINEAR_API_KEY       chiave API personale di Linear (scrittura delle issue)
//   DADAGUARD_LINEAR_DESTINAZIONI  dove si apre il ticket, per destinazione dell'allarme (route.js):
//                                  `main=<teamId>:<labelId>,<labelId>;data=<teamId>:<labelId>`.
//                                  `cron` e una destinazione assente ricadono su `main`
//   DADAGUARD_LINEAR_PRIORITA      priorità Linear del ticket (default 2 = High; 1 = Urgent)
//   DADAGUARD_LINEAR_ANCHE_STAGING 1 per aprire ticket anche per staging (di norma no: il suo load
//                                  balancer sfarfalla più volte al giorno, e non è un cliente giù)
//   DADAGUARD_PUBLIC_URL           obbligatoria: è la radice dell'URL che lega ticket e risorsa
const API = 'https://api.linear.app/graphql'
const STATI_CHIUSI = ['completed', 'canceled', 'duplicate']

export function linearConfig(env = process.env) {
  const destinazioni = {}
  for (const pezzo of String(env.DADAGUARD_LINEAR_DESTINAZIONI ?? '').split(';')) {
    const m = /^\s*([a-z]+)\s*=\s*([\w-]+)\s*(?::\s*([\w,\s-]*))?$/i.exec(pezzo)
    if (!m) continue
    const labelIds = (m[3] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    destinazioni[m[1].toLowerCase()] = { teamId: m[2], labelIds }
  }
  const priorita = Number(env.DADAGUARD_LINEAR_PRIORITA)
  return {
    apiKey: env.DADAGUARD_LINEAR_API_KEY || null,
    destinazioni,
    priorita: Number.isInteger(priorita) && priorita >= 0 && priorita <= 4 ? priorita : 2,
    ancheStaging: env.DADAGUARD_LINEAR_ANCHE_STAGING === '1',
    publicUrl: env.DADAGUARD_PUBLIC_URL || null,
  }
}

// Acceso solo se c'è tutto: la chiave, una destinazione principale e l'URL che fa da identità.
export function linearAttivo(cfg) {
  return Boolean(cfg?.apiKey && cfg.destinazioni?.main && cfg.publicUrl)
}

// L'URL che lega un ticket alla sua risorsa. È anche un link vero alla dashboard, così l'allegato sul
// ticket serve a chi lo apre e non solo a noi. Puro.
export const prefissoRisorse = (publicUrl) => `${String(publicUrl).replace(/\/+$/, '')}/?risorsa=`
export const urlRisorsa = (publicUrl, key) => `${prefissoRisorse(publicUrl)}${encodeURIComponent(key)}`

// Staging si riconosce come lo riconosce già il tag dei messaggi (`[STAGING]`), sulla chiave
// dell'account: nessuna lista di nomi da tenere. Puro.
const diStaging = (account) => envTag(account) === ' [STAGING]'

// Cosa deve fare questo giro. Puro e testabile, zero rete.
//   stato:   `next.services` del watcher (confirmed, alerted, route) dopo gli invii Slack
//   ora:     snapshot() del giro (nome, account, causa, dettaglio della risorsa)
//   aperti:  { [key]: { id, identifier } } ticket aperti trovati su Linear
// Ritorna { apri: [{ key, route, obs }], chiudi: [{ key, ticket }] }.
export function pianoTicket(stato = {}, ora = {}, aperti = {}, { ancheStaging = false } = {}) {
  const apri = []
  const chiudi = []
  for (const [key, s] of Object.entries(stato)) {
    const obs = ora[key]
    if (!obs || aperti[key]) continue
    // `alerted` vuol dire che Slack l'ha detto davvero: un rosso taciuto dal routing (un cron caduto,
    // che lo racconta già il job) non apre un ticket, e uno nato rosso prima dell'avvio nemmeno.
    if (s.confirmed !== 'down' || !s.alerted) continue
    if (!ancheStaging && diStaging(obs.accountKey ?? key.split('/')[0])) continue
    apri.push({ key, route: s.route ?? 'main', obs })
  }
  for (const [key, ticket] of Object.entries(aperti)) {
    const s = stato[key]
    // Si chiude solo su un verde CONFERMATO. Una risorsa sparita dalla vista o in `unknown` non dice
    // che il guasto è finito: il ticket resta a chi lo guarda.
    if (s && stateClass(s.confirmed) === 'quiet') chiudi.push({ key, ticket })
  }
  return { apri, chiudi }
}

// Titolo e corpo del ticket. Il titolo è la riga di Slack senza emoji e senza link: chi arriva dal
// canale riconosce la stessa frase. Puro.
export function testoTicket(key, obs, { publicUrl, t = (k) => k } = {}) {
  const causa = causeLabel({ cause: obs.cause, type: obs.type, causeType: obs.causeType, outcome: obs.outcome }, t)
  const title = `${obs.name}${envTag(obs.account)} ${t('notify.status.down')}${causa ? ` · ${causa}` : ''}`
  const righe = [
    `**Risorsa**: \`${obs.name}\` · account \`${obs.account ?? '—'}\`${obs.type ? ` · tipo \`${obs.type}\`` : ''}`,
    obs.detail ? `**Cosa vede Dadaguard**: ${String(obs.detail).replace(/\s+/g, ' ').trim()}` : null,
    `**Stato vivo**: [${t('notify.open')}](${urlRisorsa(publicUrl, key)})`,
    '',
    'Aperto da Dadaguard quando la risorsa è risultata giù per due letture di fila. Si chiude da solo quando torna verde: la causa va scritta qui sotto prima che succeda.',
  ]
  return { title, description: righe.filter((r) => r != null).join('\n') }
}

// ── Rete ──────────────────────────────────────────────────────────────────────────────────────────

async function chiamaLinear(apiKey, query, variables, { timeoutMs = 10_000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(API, {
      method: 'POST',
      // Le chiavi personali vanno senza «Bearer»: con il prefisso Linear risponde 400.
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal,
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || body?.errors?.length) {
      const msg = body?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`
      throw new Error(`linear: ${msg.slice(0, 200)}`)
    }
    return body.data
  } finally {
    clearTimeout(timer)
  }
}

// I ticket aperti di Dadaguard, per chiave di risorsa. Il filtro sta sul server: i ticket chiusi si
// accumulano, e un tetto sui risultati li farebbe passare davanti a quelli aperti.
async function ticketAperti(apiKey, prefisso) {
  const data = await chiamaLinear(
    apiKey,
    `query($p: String!, $chiusi: [String!]) {
      issues(first: 100, filter: { state: { type: { nin: $chiusi } }, attachments: { some: { url: { startsWith: $p } } } }) {
        nodes { id identifier team { id } attachments(filter: { url: { startsWith: $p } }) { nodes { url } } }
      }
    }`,
    { p: prefisso, chiusi: STATI_CHIUSI },
  )
  const out = {}
  for (const issue of data?.issues?.nodes ?? []) {
    for (const a of issue.attachments?.nodes ?? []) {
      const key = decodeURIComponent(a.url.slice(prefisso.length))
      out[key] ??= { id: issue.id, identifier: issue.identifier, teamId: issue.team?.id }
    }
  }
  return out
}

// Gli stati di un team, per tipo. Si leggono una volta per processo: cambiano di rado, e un riavvio
// (ogni deploy) li rilegge.
const statiTeam = new Map()
async function statoDi(apiKey, teamId, tipo) {
  if (!statiTeam.has(teamId)) {
    const data = await chiamaLinear(apiKey, `query($id: String!) { team(id: $id) { states { nodes { id type position } } } }`, { id: teamId })
    const nodi = [...(data?.team?.states?.nodes ?? [])].sort((a, b) => a.position - b.position)
    statiTeam.set(teamId, nodi)
  }
  return statiTeam.get(teamId).find((s) => s.type === tipo)?.id ?? null
}

async function apriTicket(cfg, { key, route, obs }, t) {
  const dest = cfg.destinazioni[route] ?? cfg.destinazioni.main
  const { title, description } = testoTicket(key, obs, { publicUrl: cfg.publicUrl, t })
  // In Triage se il team lo usa: è dove guarda chi smista. Senza, lo stato di default del team.
  const stateId = await statoDi(cfg.apiKey, dest.teamId, 'triage')
  const data = await chiamaLinear(
    cfg.apiKey,
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier url } } }`,
    {
      input: {
        teamId: dest.teamId,
        title,
        description,
        priority: cfg.priorita,
        ...(dest.labelIds.length ? { labelIds: dest.labelIds } : {}),
        ...(stateId ? { stateId } : {}),
      },
    },
  )
  const issue = data?.issueCreate?.issue
  if (!issue) throw new Error('linear: issueCreate senza issue')
  // L'allegato è l'identità: senza, al giro dopo il ticket non si ritrova e se ne apre un secondo.
  await chiamaLinear(
    cfg.apiKey,
    `mutation($id: String!, $url: String!, $title: String) { attachmentLinkURL(issueId: $id, url: $url, title: $title) { success } }`,
    { id: issue.id, url: urlRisorsa(cfg.publicUrl, key), title: `Dadaguard · ${obs.name}` },
  )
  return issue
}

async function chiudiTicket(cfg, { ticket }, t) {
  await chiamaLinear(
    cfg.apiKey,
    `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
    { input: { issueId: ticket.id, body: `✅ ${t('notify.status.up')}: Dadaguard la vede verde da due letture di fila, chiudo il ticket.` } },
  )
  const stateId = ticket.teamId ? await statoDi(cfg.apiKey, ticket.teamId, 'completed') : null
  if (!stateId) throw new Error(`linear: nessuno stato completed per ${ticket.identifier}`)
  await chiamaLinear(cfg.apiKey, `mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`, {
    id: ticket.id,
    stateId,
  })
}

// Il giro dei ticket. Ogni errore resta qui: un guasto di Linear non deve fermare Slack né il giro dopo.
export async function giroTicket(cfg, stato, ora, { t = (k) => k, deps = {} } = {}) {
  if (!linearAttivo(cfg)) return { spento: true }
  const leggi = deps.ticketAperti ?? ticketAperti
  const apri = deps.apriTicket ?? apriTicket
  const chiudi = deps.chiudiTicket ?? chiudiTicket
  const aperti = await leggi(cfg.apiKey, prefissoRisorse(cfg.publicUrl))
  const piano = pianoTicket(stato, ora, aperti, { ancheStaging: cfg.ancheStaging })
  const esito = { aperti: [], chiusi: [], falliti: 0 }
  for (const voce of piano.apri) {
    try {
      const issue = await apri(cfg, voce, t)
      esito.aperti.push(issue.identifier)
      log.info('linear: ticket aperto', { risorsa: voce.key, ticket: issue.identifier })
    } catch (err) {
      esito.falliti++
      log.error('linear: apertura fallita', { risorsa: voce.key, err: err.message })
    }
  }
  for (const voce of piano.chiudi) {
    try {
      await chiudi(cfg, voce, t)
      esito.chiusi.push(voce.ticket.identifier)
      log.info('linear: ticket chiuso', { risorsa: voce.key, ticket: voce.ticket.identifier })
    } catch (err) {
      esito.falliti++
      log.error('linear: chiusura fallita', { risorsa: voce.key, err: err.message })
    }
  }
  return esito
}
