import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// GUARDIANO delle chiavi i18n usate nel FRONTEND. Il test di parità (test/i18n.test.js) garantisce che
// IT ed EN abbiano le stesse chiavi; questo garantisce l'altra metà, che mancava: che le chiavi USATE
// dal codice esistano nel dizionario.
//
// Perché serve, con un esempio vero: il server mandava `trigger: 'break-glass APERTO'` (una frase
// italiana) e la pagina ci costruiva sopra `t('deploys.trigger.' + trigger)`. La chiave non esisteva,
// quindi in pagina compariva la CHIAVE («deploys.trigger.break-glass APERTO») e in inglese sarebbe
// uscito italiano. Nessun test lo vedeva: la parità era a posto, e la chiave era dinamica.
//
// Due controlli, uno per ciascuna delle due forme:
//  · chiavi LETTERALI: `t('x.y')` → devono esistere;
//  · chiavi COMPOSTE su un valore che decide il server: le famiglie note si verificano contro i valori
//    che il server può davvero produrre (qui: i `trigger` delle azioni a mano). È il caso che è
//    sfuggito, ed è l'unico modo di prenderlo senza far girare un browser.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const src = readFileSync(join(root, 'web/i18n.jsx'), 'utf8')

function estraiBlocco(lang) {
  const head = new RegExp('(^|\\n)[ \\t]*' + lang + ':\\s*\\{')
  const m = head.exec(src)
  assert.ok(m, `blocco "${lang}" non trovato`)
  const open = src.indexOf('{', m.index)
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}' && --depth === 0) return src.slice(open + 1, j)
  }
  throw new Error(`blocco "${lang}" non bilanciato`)
}

function chiavi(block) {
  const out = new Set()
  const re = /(?:^|\n)\s*(?:'([^']+)'|"([^"]+)")\s*:/g
  let m
  while ((m = re.exec(block))) out.add(m[1] ?? m[2])
  return out
}

const IT = chiavi(estraiBlocco('it'))
const EN = chiavi(estraiBlocco('en'))

// Tutti i file del frontend, ricorsivamente (i18n.jsx escluso: lì ci sono le DEFINIZIONI, non gli usi).
function fileWeb(dir = join(root, 'web')) {
  const out = []
  for (const voce of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, voce.name)
    if (voce.isDirectory()) out.push(...fileWeb(p))
    else if (/\.(jsx?|mjs)$/.test(voce.name) && voce.name !== 'i18n.jsx') out.push(p)
  }
  return out
}

const FILE = fileWeb()

test('i18n web: le chiavi letterali usate nel frontend esistono in IT e EN', () => {
  const mancanti = []
  for (const f of FILE) {
    const testo = readFileSync(f, 'utf8')
    // `t('chiave')` con la chiave scritta per intero. Le chiavi hanno sempre un punto: senza quel
    // vincolo entrerebbero anche `t(nome)` e le stringhe di altre funzioni con lo stesso nome.
    const re = /\bt\(\s*'([a-zA-Z][\w.-]*\.[\w.-]+)'/g
    let m
    while ((m = re.exec(testo))) {
      const k = m[1]
      if (!IT.has(k) || !EN.has(k)) mancanti.push(`${f.replace(root + '/', '')}: ${k}`)
    }
  }
  assert.deepEqual([...new Set(mancanti)], [], `chiavi usate nel frontend e assenti nel dizionario:\n${mancanti.join('\n')}`)
})

// I `trigger` che il server può produrre, letti DAL SERVER: se domani ne nasce uno nuovo senza la sua
// frase, cade qui invece di comparire in pagina come una chiave grezza.
test('i18n web: ogni `trigger` prodotto dal server ha la sua frase in IT e EN', async () => {
  const azioni = await import('../server/manualActions.js')
  const deploys = await import('../server/deploys.js')
  const trigger = new Set()

  // Azioni a mano: le tre righe di audit più il riavvio.
  const eventoSg = (nome) =>
    ({ EventId: 'e1', EventTime: new Date().toISOString(), CloudTrailEvent: JSON.stringify({ eventName: nome, requestParameters: { groupId: 'sg-1', ipPermissions: { items: [{ fromPort: 5432 }] } }, userIdentity: { arn: 'arn:aws:sts::1:assumed-role/ruolo/persona' } }) })
  trigger.add(azioni.sgRow(eventoSg('AuthorizeSecurityGroupIngress')).trigger)
  trigger.add(azioni.sgRow(eventoSg('RevokeSecurityGroupIngress')).trigger)
  trigger.add(
    azioni.execRow({ EventId: 'e2', EventTime: new Date().toISOString(), CloudTrailEvent: JSON.stringify({ eventName: 'ExecuteCommand', requestParameters: { cluster: 'c', task: 't' }, userIdentity: { arn: 'arn:aws:sts::1:assumed-role/ruolo/persona' } }) }).trigger,
  )
  trigger.add(
    azioni.restartRow({ EventId: 'e3', EventTime: new Date().toISOString(), CloudTrailEvent: JSON.stringify({ eventName: 'UpdateService', requestParameters: { cluster: 'c', service: 's', forceNewDeployment: true }, userIdentity: { arn: 'arn:aws:sts::1:assumed-role/ruolo/persona' } }) })?.trigger,
  )

  // Build: i trigger che `resolveTrigger` sa restituire.
  for (const arg of [
    [undefined, null],
    ['GitHub-Hookshot/abc', null],
    ['codepipeline/x', null],
    ['persona', null],
    ['persona', { hotfix: true }],
  ]) {
    trigger.add(deploys.resolveTrigger(...arg))
  }

  const mancanti = [...trigger]
    .filter(Boolean)
    .map((v) => `deploys.trigger.${v}`)
    .filter((k) => !IT.has(k) || !EN.has(k))
  assert.deepEqual(mancanti, [], `trigger senza frase nel dizionario: ${mancanti.join(', ')}`)
})
