import { test } from 'node:test'
import assert from 'node:assert/strict'
import { asList, matchesAny, isFiltering } from '../web/filters.js'

// Il modello dei filtri: ELENCO VUOTO = TUTTI. Sembra una sciocchezza, ma prima ogni pagina scriveva a
// mano `x === 'all' || y === x`, in sei file, e ognuno poteva sbagliarlo a modo suo. Qui si fissa il
// comportamento una volta: compreso quello con i preset SALVATI PRIMA, che contengono le forme vecchie.

test('asList: il sentinella «all» e i vuoti diventano nessun filtro', () => {
  assert.deepEqual(asList('all'), [])
  assert.deepEqual(asList(null), [])
  assert.deepEqual(asList(undefined), [])
  assert.deepEqual(asList(''), [])
  assert.deepEqual(asList([]), [])
})

test('asList: un valore singolo (preset salvato ieri) diventa un elenco di uno', () => {
  assert.deepEqual(asList('production'), ['production'])
  assert.deepEqual(asList(['production', 'staging']), ['production', 'staging'])
})

test('asList: «all» dentro un elenco non sopravvive (sarebbe un valore fra gli altri)', () => {
  assert.deepEqual(asList(['all', 'staging']), ['staging'])
  assert.deepEqual(asList(['staging', null, '', 'production']), ['staging', 'production'])
})

test('matchesAny: nessuna scelta = passa tutto; con delle scelte passa solo chi è dentro', () => {
  assert.equal(matchesAny('production', []), true)
  assert.equal(matchesAny('production', 'all'), true)
  assert.equal(matchesAny('production', ['production', 'staging']), true)
  assert.equal(matchesAny('management', ['production', 'staging']), false)
  // Compatibilità con la forma vecchia, senza dover convertire i preset salvati.
  assert.equal(matchesAny('production', 'production'), true)
  assert.equal(matchesAny('staging', 'production'), false)
})

test('matchesAny: un valore assente non passa un filtro attivo, ma passa se non filtri', () => {
  assert.equal(matchesAny(undefined, ['production']), false)
  assert.equal(matchesAny(undefined, []), true)
})

test('isFiltering: dice se qualcuno ha scelto qualcosa (serve al tasto «azzera»)', () => {
  assert.equal(isFiltering([]), false)
  assert.equal(isFiltering('all'), false)
  assert.equal(isFiltering(['staging']), true)
  assert.equal(isFiltering('staging'), true)
})
