import { test } from 'node:test'
import assert from 'node:assert/strict'
import { asList, matchesAny, isFiltering, listaDaUrl, potaSconosciuti, filtriDaUrl, filtriInUrl } from '../web/filters.js'

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

test('listaDaUrl legge i filtri che arrivano da un link', () => {
  // I link delle notifiche #aws-deploy: `?service=frontend&account=staging`.
  assert.deepEqual(listaDaUrl('?service=frontend&account=staging', 'account'), ['staging'])
  assert.deepEqual(listaDaUrl('?service=backend,frontend', 'service'), ['backend', 'frontend'])
  // Parametro assente, vuoto o `all`: nessun filtro, cioè la pagina di sempre.
  assert.deepEqual(listaDaUrl('?service=backend', 'account'), [])
  assert.deepEqual(listaDaUrl('?account=', 'account'), [])
  assert.deepEqual(listaDaUrl('', 'account'), [])
  assert.deepEqual(listaDaUrl(undefined, 'account'), [])
})

test('listaDaUrl non si fa fregare dallo spazio dopo la virgola', () => {
  assert.deepEqual(listaDaUrl('?service=backend, frontend', 'service'), ['backend', 'frontend'])
})

test('potaSconosciuti toglie le chiavi che non esistono, e aspetta i dati', () => {
  assert.deepEqual(potaSconosciuti(['prod'], ['production', 'staging']), [])
  assert.deepEqual(potaSconosciuti(['staging'], ['production', 'staging']), ['staging'])
  // Chiavi non ancora note (dati in arrivo): non si pota niente, sennò il link non varrebbe mai.
  assert.deepEqual(potaSconosciuti(['staging'], []), ['staging'])
})

// I filtri di Servizi nell'URL: un link `?type=bedrock` deve aprire la pagina con la tendina Tipo gia'
// scelta, e la pagina deve scrivere nell'indirizzo quello che si sceglie a mano.
test('filtriDaUrl legge solo i campi presenti, e ignora i valori che non conosce', () => {
  assert.deepEqual(filtriDaUrl('?type=bedrock,lambda&status=down&region=eu-west-1&schedule=cron&tf=unmanaged&problems=1'), {
    typeFilter: ['bedrock', 'lambda'],
    statusFilter: ['down'],
    regionFilter: ['eu-west-1'],
    scheduleFilter: 'cron',
    managedFilter: 'unmanaged',
    problemsOnly: true,
  })
  // Un campo assente non diventa «vuoto»: resta quello che App ha gia' (ricerca, ambiente).
  assert.deepEqual(filtriDaUrl('?q=api&account=staging'), {})
  assert.deepEqual(filtriDaUrl('?tf=forse&schedule=sempre&problems=si'), {})
  assert.deepEqual(filtriDaUrl(''), {})
})

test('filtriInUrl scrive i filtri scelti, toglie quelli al default e tiene gli altri parametri', () => {
  const f = {
    nameQuery: ' api ',
    accountFilter: ['production'],
    typeFilter: ['lambda', 'bedrock'],
    statusFilter: [],
    regionFilter: [],
    scheduleFilter: 'all',
    managedFilter: 'managed',
    problemsOnly: false,
  }
  assert.equal(filtriInUrl('?altro=1&status=down', f), 'altro=1&q=api&account=production&type=lambda,bedrock&tf=managed')
  // Tutto al default: l'indirizzo torna pulito.
  assert.equal(filtriInUrl('?q=x&type=ecs&problems=1', { scheduleFilter: 'all', managedFilter: 'all' }), '')
})

test('filtriInUrl e filtriDaUrl fanno andata e ritorno', () => {
  const f = { typeFilter: ['bedrock'], statusFilter: ['down', 'degraded'], regionFilter: ['us-east-1'], scheduleFilter: 'ondemand', managedFilter: 'unmanaged', problemsOnly: true }
  assert.deepEqual(filtriDaUrl(`?${filtriInUrl('', f)}`), f)
})
