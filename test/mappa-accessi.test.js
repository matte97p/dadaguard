import { test } from 'node:test'
import assert from 'node:assert/strict'
import { componiMappa, normalizza, rispostaMappa } from '../server/mappaAccessi.js'

// Le regole dell'incrocio fra le tre fonti degli accessi. Sono provate qui e non a mano sulla pagina
// perche' sbagliano in silenzio: una riga accoppiata male non si vede come un errore, si legge come
// «questa persona ha questi permessi», che e' la frase su cui poi qualcuno decide.

const AUDIT = (persone) => ({ persone })
const RUOLI = (teams, extra = {}) => ({ teams, ...extra })
// Identity Center come lo restituisce `ssoAccess()`: permission set → assegnatari.
const SSO = (permissionSets) => ({ available: true, permissionSets })

test('i ruoli di una persona sono l unione dei ruoli dei suoi team', () => {
  const { persone } = componiMappa({
    audit: AUDIT([{ utente: 'alex', teams: ['db-read', 'logs'], ultimoLoginOk: 1000 }]),
    ruoli: RUOLI({ 'db-read': ['db-app-ro', 'db-orders-ro'], logs: ['logs-prod-read', 'db-app-ro'] }),
  })
  // Uniti e senza doppioni: `db-app-ro` arriva da tutti e due i team ed e' un ruolo solo.
  assert.deepEqual(persone[0].ruoli, ['db-app-ro', 'db-orders-ro', 'logs-prod-read'])
})

test('un team che la mappa non nomina non concede niente, e la riga lo dice', () => {
  const { persone, teams } = componiMappa({
    audit: AUDIT([{ utente: 'kim', teams: ['app-repos', 'db-write'], ultimoLoginOk: 1 }]),
    ruoli: RUOLI({ 'db-write': ['db-app-rw'], 'app-repos': [] }),
  })
  assert.deepEqual(persone[0].ruoli, ['db-app-rw'])
  assert.deepEqual(persone[0].teamsSenzaRuoli, ['app-repos'])
  assert.equal(teams.find((t) => t.team === 'app-repos').soloRepo, true)
  assert.equal(teams.find((t) => t.team === 'db-write').soloRepo, false)
})

test('nessun login nella finestra non e nessun team: i due casi restano distinti', () => {
  const { persone } = componiMappa({
    audit: AUDIT([
      { utente: 'senzaLogin' }, // mai visto entrare: `teams` non c'e'
      { utente: 'senzaTeam', teams: [], ultimoLoginOk: 5 }, // entrato, e il connector non gli da' team
    ]),
  })
  const a = persone.find((p) => p.persona === 'senzaLogin')
  const b = persone.find((p) => p.persona === 'senzaTeam')
  assert.equal(a.teamsNoti, false)
  assert.equal(b.teamsNoti, true)
  assert.deepEqual(b.teams, [])
})

test('le due directory si agganciano sul nome normalizzato, cifre in coda comprese', () => {
  const { persone } = componiMappa({
    audit: AUDIT([{ utente: 'GiuliaVerdi88', teams: [], ultimoLoginOk: 1 }]),
    sso: SSO([{ name: 'data-readonly', assignments: [{ account: 'Production', type: 'group', name: 'data', members: ['GiuliaVerdi'] }] }]),
  })
  assert.equal(persone.length, 1, 'la stessa persona resta UNA riga, non due')
  assert.equal(persone[0].ssoUtente, 'GiuliaVerdi')
  assert.deepEqual(persone[0].gruppiSso, ['data'])
  assert.deepEqual(persone[0].permessi, [{ account: 'Production', permissionSet: 'data-readonly', via: 'data' }])
})

test('quando il nome non basta, l eccezione in config aggancia lo stesso', () => {
  const argomenti = {
    audit: AUDIT([{ utente: 'gverdi23x', teams: [], ultimoLoginOk: 1 }]),
    sso: SSO([{ name: 'billing-admin', assignments: [{ account: 'Payer', type: 'user', name: 'GiuliaRossi' }] }]),
  }
  // Senza eccezione i due nomi non si somigliano: due righe, e nessuna inventa permessi dell'altra.
  const senza = componiMappa(argomenti)
  assert.equal(senza.persone.length, 2)
  assert.equal(senza.persone.find((p) => p.persona === 'gverdi23x').permessi.length, 0)

  const con = componiMappa({ ...argomenti, cfg: { persone: [{ github: 'gverdi23x', sso: 'GiuliaRossi' }] } })
  assert.equal(con.persone.length, 1)
  assert.equal(con.persone[0].permessi[0].permissionSet, 'billing-admin')
})

test('chi non entra da Teleport compare lo stesso, marcato «solo portale»', () => {
  const { persone } = componiMappa({
    audit: AUDIT([]),
    sso: SSO([{ name: 'dev-logs-readonly', assignments: [{ account: 'Staging', type: 'group', name: 'developers', members: ['rin'] }] }]),
  })
  assert.equal(persone[0].persona, 'rin')
  assert.equal(persone[0].soloSso, true)
  assert.equal(persone[0].ultimoLogin, null)
  assert.deepEqual(persone[0].ruoli, [])
})

test('due utenze che normalizzano uguale non si fondono in una persona sola', () => {
  const { persone } = componiMappa({
    audit: AUDIT([{ utente: 'mrossi1', teams: [], ultimoLoginOk: 1 }]),
    sso: SSO([
      { name: 'ps-a', assignments: [{ account: 'Production', type: 'user', name: 'mrossi' }] },
      { name: 'ps-b', assignments: [{ account: 'Production', type: 'user', name: 'MRossi2' }] },
    ]),
  })
  // `mrossi1` si aggancia alla PRIMA (`mrossi`); l'altra resta una riga sua invece di sparire dentro
  // la stessa persona portandosi dietro i suoi permessi.
  const agganciata = persone.find((p) => p.persona === 'mrossi1')
  assert.equal(agganciata.ssoUtente, 'mrossi')
  assert.deepEqual(agganciata.permessi.map((x) => x.permissionSet), ['ps-a'])
  assert.ok(persone.some((p) => p.persona === 'MRossi2' && p.soloSso))
})

test('un gruppo senza membri resta in elenco: e un permesso acceso che non serve a nessuno', () => {
  const { gruppiSso } = componiMappa({
    sso: SSO([{ name: 'ops-readonly', assignments: [{ account: 'Production', type: 'group', name: 'vecchio-team', members: [] }] }]),
  })
  assert.equal(gruppiSso.length, 1)
  assert.deepEqual(gruppiSso[0].membri, [])
  assert.equal(gruppiSso[0].permessi.length, 1)
})

test('un team mappato che nessuno usa compare comunque, con zero membri', () => {
  const { teams } = componiMappa({ audit: AUDIT([]), ruoli: RUOLI({ 'team-fantasma': ['un-ruolo'] }) })
  assert.deepEqual(teams, [{ team: 'team-fantasma', ruoli: ['un-ruolo'], membri: [], soloRepo: false }])
})

test('normalizza: minuscolo, senza separatori, senza le cifre in CODA', () => {
  assert.equal(normalizza('GiuliaVerdi88'), 'giuliaverdi')
  assert.equal(normalizza('giulia.rossi'), 'giuliarossi')
  assert.equal(normalizza('m4rco'), 'm4rco', 'le cifre in mezzo distinguono davvero due persone')
  assert.equal(normalizza(null), '')
})

// ── La risposta della rotta ───────────────────────────────────────────────────────────────────────
// Provata perche' e' dove si e' rotta davvero, il 01/09/2026: dopo un riordino il pezzo che elenca i
// gruppi nominava una variabile che non esisteva piu' in quella funzione. La rotta rispondeva 500 e la
// pagina mostrava due tabelle vuote col messaggio «nessuna persona», cioe' un guasto travestito da
// assenza di dati. Le prove sull'incrocio erano tutte verdi: non passavano di qui.
test('la risposta della rotta si monta tutta, gruppi compresi', () => {
  const r = rispostaMappa({
    audit: { persone: [{ utente: 'alex', teams: ['db-read'], ultimoLoginOk: 1 }] },
    ruoli: { teams: { 'db-read': ['db-app-ro'] }, generato: '2026-09-01T00:00:00Z' },
    sso: { available: true, permissionSets: [{ name: 'ps-a', assignments: [{ account: 'Production', type: 'group', name: 'gruppo', members: ['alex'] }] }] },
    ore: 168,
  })
  assert.equal(r.configurato, true)
  assert.equal(r.persone.length, 1)
  assert.deepEqual(r.gruppiSso.map((g) => g.gruppo), ['gruppo'])
  assert.deepEqual(r.fonti.teleport, { ok: true, persone: 1, troncato: false })
  assert.equal(r.fonti.ruoli.ok, true)
  assert.equal(r.fonti.sso.ok, true)
})

test('ogni fonte rotta si dice per quello che e: errore, assente, tetto toccato', () => {
  const rotta = rispostaMappa({
    audit: { errore: 'AccessDenied', persone: [] },
    ruoli: { assente: true, teams: {} },
    sso: { errore: 'no SSO' },
    nomeParam: '/teleport/team-roles',
  })
  assert.deepEqual(rotta.fonti.teleport, { errore: 'AccessDenied' })
  assert.deepEqual(rotta.fonti.ruoli, { assente: '/teleport/team-roles' })
  assert.deepEqual(rotta.fonti.sso, { errore: 'no SSO' })
  // Vuoto sì, ma montato: la pagina deve poter dire perché, non mostrare una tabella muta.
  assert.deepEqual(rotta.persone, [])
  assert.deepEqual(rotta.gruppiSso, [])

  const lenta = rispostaMappa({ audit: { incompleta: 'Running', persone: [] } })
  assert.deepEqual(lenta.fonti.teleport, { incompleta: 'Running' })

  const tetto = rispostaMappa({ audit: { persone: [{ utente: 'alex' }], troncato: true } })
  assert.equal(tetto.fonti.teleport.troncato, true)
})
