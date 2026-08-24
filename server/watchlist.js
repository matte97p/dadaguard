import { readFileSync, writeFileSync } from 'node:fs'
import { parseDocument } from 'yaml'
import { CONFIG_PATH } from './config.js'
import { isCloud } from './mode.js'
import { resourceId } from './autodiscover.js'

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
  if (isCloud) {
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

// Identità di una voce di services.yaml, nella stessa forma del payload dello stato: serve a
// riconoscere QUALE riga della dashboard corrisponde a QUALE voce del file.
const idOf = (entry) => resourceId({ account: entry?.account, aws: entry?.aws })

// QUALE voce cancellare. Pura e testabile di proposito: `CONFIG_PATH` è un file solo, quindi la
// scelta si prova qui e non scrivendo il services.yaml del repo.
//
// Il bersaglio è l'identità della riga cliccata, non il nome nudo: services.yaml può avere due voci
// omonime (un servizio ECS e il suo ALB, la stessa ECS in due cluster, lo stesso nome in due account)
// e cancellare la prima che combacia vuol dire togliere il monitoraggio di un ALTRO servizio, con la
// UI che dice "fatto". È una scrittura che dalla dashboard non si annulla, quindi davanti a un
// bersaglio ambiguo NON si indovina: si alza un errore che dice quante voci combaciano.
export function targetIndex(entries = [], target = {}) {
  const { name, account, resourceId: rid } = typeof target === 'string' ? { name: target } : target
  if (!name) return -1
  const combacia = entries
    .map((entry, idx) => ({ entry, idx }))
    .filter(({ entry }) => entry?.name === name)
    // L'account restringe solo se lo sappiamo da entrambe le parti: una voce senza `account` nel file
    // vale per l'account che il risolutore le assegna, e scartarla qui vorrebbe dire non cancellare
    // mai niente.
    .filter(({ entry }) => !account || !entry.account || entry.account === account)

  if (combacia.length === 0) return -1
  // Con l'identità di risorsa la scelta è esatta: è l'unica cosa che separa due voci che si somigliano
  // in tutto il resto.
  const esatta = rid ? combacia.filter(({ entry }) => idOf(entry) === rid) : []
  if (esatta.length === 1) return esatta[0].idx
  if (combacia.length === 1) return combacia[0].idx
  throw new Error(
    `"${name}" combacia con ${combacia.length} voci di services.yaml e non c'è modo di dire quale: rimuovila a mano dal file`,
  )
}

// Rimuove un servizio dalla watchlist. Accetta l'identità della riga (`{ name, account, resourceId }`)
// e ancora la stringa nuda, per le chiamate vecchie e per i file dove i nomi sono unici davvero.
// Ritorna true se rimosso.
export function removeService(target) {
  assertWritable()
  const doc = load()
  const services = doc.get('services')
  if (!services) return false
  const entries = services.items.map((item) => (item?.toJSON ? item.toJSON() : item))
  const idx = targetIndex(entries, target)
  if (idx === -1) return false
  services.delete(idx)
  persist(doc)
  return true
}
