import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adiacenze, raggiungibili, rischi, impatto, inDifficolta } from '../web/topoImpact.js'

// LO SCOPO della pagina Topologia, in forma di test: «se questo si ferma, chi ne soffre?» e «questo è
// rotto, da cosa dipende?». Sono le due domande per cui vale la pena avere un disegno invece di un
// elenco, e le risposte le calcola questo modulo.

const svc = (name, overall = 'up', account = 'prod') => ({ name, overall, account: { key: account, label: account } })
const arco = (a, b, vias = ['env']) => ({ source: a, target: b, vias })

test('il danno RIMBALZA: chi dipende da un guasto anche di riflesso è a rischio, e si dice da cosa', () => {
  // alb → backend → redis, e il Redis è giù. Il backend ne soffre perché lo usa; l'alb ne soffre perché
  // dietro non risponde più nessuno. La catena a due passi è proprio quella che a mente non si ricostruisce.
  const servizi = [svc('alb'), svc('backend'), svc('redis', 'down')]
  const edges = [arco('prod::alb', 'prod::backend', ['lb']), arco('prod::backend', 'prod::redis')]
  const r = rischi(servizi, edges)
  assert.deepEqual(r.get('prod::backend'), ['redis'])
  assert.deepEqual(r.get('prod::alb'), ['redis'])
  // Il guasto NON è fra le vittime: sarebbe la stessa riga scritta due volte, una in rosso e una in giallo.
  assert.equal(r.has('prod::redis'), false)
})

test('un PERMESSO non è un uso: gli archi IAM non propagano il danno', () => {
  // «Questo ruolo potrebbe scrivere su quel bucket» non dice che ci scriva. Contarlo renderebbe a rischio
  // qualunque servizio con una policy larga, e una riga che si accende sempre è una riga che si ignora.
  const servizi = [svc('reporting'), svc('bucket', 'down')]
  assert.equal(rischi(servizi, [arco('prod::reporting', 'prod::bucket', ['iam'])]).size, 0)
  // Lo stesso arco con anche una via vera propaga: la policy non toglie il fatto che lo citi in config.
  assert.deepEqual(rischi(servizi, [arco('prod::reporting', 'prod::bucket', ['iam', 'env'])]).get('prod::reporting'), ['bucket'])
})

test('«non lo so» non è un guasto: lo stato ignoto non colora niente', () => {
  // I nodi arrivano dal grafo prima dello stato della flotta: propagare `unknown` accenderebbe mezza
  // mappa a ogni apertura della pagina, che è il modo più rapido per rendere il colore inutile.
  assert.equal(inDifficolta([svc('a', 'unknown'), svc('b', 'idle'), svc('c', 'disabled')]).size, 0)
  assert.deepEqual([...inDifficolta([svc('a', 'degraded')]).values()], ['a'])
})

test('due servizi che si citano a vicenda non fanno girare la visita per sempre', () => {
  // Backend e chat si citano davvero l'uno con l'altro. Una visita ingenua qui non tornerebbe mai.
  const edges = [arco('prod::a', 'prod::b'), arco('prod::b', 'prod::a')]
  const { avanti } = adiacenze(edges)
  assert.deepEqual([...raggiungibili('prod::a', avanti)], ['prod::b'])
  assert.equal(rischi([svc('a'), svc('b', 'down')], edges).get('prod::a')[0], 'b')
})

test('le due risposte per una risorsa: chi ne soffre e da cosa dipende', () => {
  const servizi = [svc('alb'), svc('backend'), svc('redis'), svc('supabase.co')]
  const edges = [
    arco('prod::alb', 'prod::backend', ['lb']),
    arco('prod::backend', 'prod::redis'),
    arco('prod::backend', 'prod::supabase.co'),
  ]
  const imp = impatto('prod::backend', servizi, edges)
  assert.deepEqual(imp.aValle, ['alb'])
  assert.deepEqual(imp.dipendenze, ['redis', 'supabase.co'])
  // Un nodo isolato risponde zero e zero, non esplode.
  assert.deepEqual(impatto('prod::mai-visto', servizi, edges), { aValle: [], dipendenze: [] })
})

test('le dipendenze CROSS-ACCOUNT contano: sono il caso per cui si guarda un disegno', () => {
  // Una lambda di staging che legge il database di produzione esiste, ed è la dipendenza che sorprende.
  const servizi = [svc('nightly-report', 'up', 'staging'), svc('main-db', 'down', 'production')]
  const r = rischi(servizi, [arco('staging::nightly-report', 'production::main-db')])
  assert.deepEqual(r.get('staging::nightly-report'), ['main-db'])
})

test('i sistemi fuori da AWS entrano nel conto col loro nome, non con un identificativo', () => {
  const esterno = { name: 'esempio.co', overall: 'unknown', esterno: { id: 'ext:host:esempio.co', label: 'esempio.co' } }
  const imp = impatto('prod::backend', [svc('backend'), esterno], [arco('prod::backend', 'ext:host:esempio.co')])
  assert.deepEqual(imp.dipendenze, ['esempio.co'])
})
