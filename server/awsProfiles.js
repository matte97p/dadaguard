// Auto-discovery LOCALE degli account dai profili AWS SSO (`~/.aws/config`): zero config manuale.
// Ogni profilo con `sso_account_id` diventa un account; dedup per account id, preferendo il profilo
// "primario" (senza suffisso -ro / prefisso dev- / "readonly"). Read-only, SOLO locale: in cloud non
// c'è `~/.aws/config` e gli account si enumerano dal blocco `org` (vedi ./org.js).
//
// `backup` & co. non compaiono mai se non sono nel tuo `~/.aws/config`; in più c'è `exclude` (per Id o
// Nome) per saltarne di espliciti. Puro/testabile: parsing INI + costruzione mappa separati dall'I/O.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const titleCase = (s) =>
  String(s)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()

// Palette deterministica: colore stabile per account (hash dell'id), così non "salta" tra un refresh e l'altro.
const PALETTE = ['#1677ff', '#52c41a', '#722ed1', '#13c2c2', '#fa8c16', '#eb2f96', '#faad14', '#2f54eb']
function colorFor(id) {
  let h = 0
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

// Quanto un profilo è "secondario" per lo stesso account: più alto = meno preferito (ro/dev/readonly).
function rank(name) {
  let r = 0
  if (/(^|[-_])ro([-_]|$)|readonly/i.test(name)) r += 2
  if (/^dev[-_]/i.test(name)) r += 1
  return r
}

// Parsing INI di `~/.aws/config` (puro/testabile). Ritorna i profili CON `sso_account_id`:
// [{ name, accountId, region }]. Salta commenti di riga (# o ;), sezioni senza SSO e `[sso-session ...]`.
export function parseAwsProfiles(text = '') {
  const sections = []
  let cur = null
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const sec = line.match(/^\[(.+)\]$/)
    if (sec) {
      const name = sec[1].trim().replace(/^profile\s+/, '')
      cur = { name, props: {} }
      sections.push(cur)
      continue
    }
    const eq = line.indexOf('=')
    if (eq > 0 && cur) cur.props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return sections
    .filter((s) => s.props['sso_account_id'])
    .map((s) => ({ name: s.name, accountId: s.props['sso_account_id'], region: s.props['region'] || undefined }))
}

// Profili → mappa { accountKey: { profile, accountId, region, label, color, discovered } }.
// Dedup per accountId (profilo primario), salta gli `exclude` (Id o Nome). Puro/testabile.
export function accountsFromProfiles(profiles = [], { exclude = [] } = {}) {
  const ex = new Set((exclude ?? []).map(String))
  const byId = new Map()
  for (const p of profiles) {
    if (!p.accountId) continue
    if (ex.has(String(p.accountId)) || ex.has(p.name)) continue
    const cur = byId.get(p.accountId)
    if (!cur) {
      byId.set(p.accountId, p)
      continue
    }
    const better = rank(p.name) < rank(cur.name) || (rank(p.name) === rank(cur.name) && p.name.length < cur.name.length)
    if (better) byId.set(p.accountId, p)
  }
  const out = {}
  for (const p of byId.values()) {
    out[slug(p.name)] = {
      profile: p.name,
      accountId: p.accountId,
      region: p.region,
      label: titleCase(p.name),
      color: colorFor(p.accountId),
      discovered: true,
    }
  }
  return out
}

// Legge `~/.aws/config` (o $AWS_CONFIG_FILE) e ne ricava gli account. File assente/illeggibile → {}.
export function discoverProfileAccounts(opts = {}) {
  const path = process.env.AWS_CONFIG_FILE || join(homedir(), '.aws', 'config')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  return accountsFromProfiles(parseAwsProfiles(text), opts)
}
