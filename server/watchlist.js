import { readFileSync, writeFileSync } from 'node:fs'
import { parseDocument } from 'yaml'
import { CONFIG_PATH } from './config.js'

// La watchlist È services.yaml. Add/remove modificano SOLO questo file locale
// (cosa monitoro), MAI l'infra AWS. Usiamo la Document API di `yaml` per
// preservare commenti e struttura del file.

function load() {
  return parseDocument(readFileSync(CONFIG_PATH, 'utf8'))
}

function persist(doc) {
  writeFileSync(CONFIG_PATH, doc.toString())
}

// In cloud il config arriva da env (SSM), non da un file: la watchlist non è
// scrivibile dalla dashboard. Errore chiaro invece di un ENOENT su /app/services.yaml.
function assertWritable() {
  if (process.env.DADAGUARD_CONFIG) {
    throw new Error(
      'config read-only in cloud: modifica la watchlist aggiornando il parametro SSM /dadaguard/services-yaml, non dalla dashboard',
    )
  }
}

// Aggiunge servizi alla watchlist. entries: [{ name, account?, aws?, healthUrl? }].
// Salta i name già presenti. Ritorna il numero di servizi aggiunti.
export function addServices(entries = []) {
  assertWritable()
  const doc = load()
  let services = doc.get('services')
  if (!services) {
    doc.set('services', [])
    services = doc.get('services')
  }
  const existing = new Set(services.items.map((it) => it.get('name')))

  let added = 0
  for (const e of entries) {
    if (!e?.name || existing.has(e.name)) continue
    const obj = { name: e.name }
    if (e.account) obj.account = e.account
    if (e.healthUrl) obj.healthUrl = e.healthUrl
    if (e.aws) obj.aws = e.aws

    const node = doc.createNode(obj)
    const awsNode = e.aws ? node.get('aws', true) : null
    if (awsNode) awsNode.flow = true // aws inline: { type: ..., ... }
    services.add(node)
    existing.add(e.name)
    added++
  }

  persist(doc)
  return added
}

// Rimuove un servizio dalla watchlist per name. Ritorna true se rimosso.
export function removeService(name) {
  assertWritable()
  const doc = load()
  const services = doc.get('services')
  if (!services) return false
  const idx = services.items.findIndex((it) => it.get('name') === name)
  if (idx === -1) return false
  services.delete(idx)
  persist(doc)
  return true
}
