// Il nome di un cron è il percorso del suo codice (il tag AWS `Codice`), con il link al sorgente, i
// reaper dentro la riga del loro job e i cron della squadra infra in fondo. Qui si inchiodano le parti
// pure: lettura del tag, etichetta, link, distinzione di due job sullo stesso script, piega dei reaper,
// divisione infra, e come tutto questo arriva alla riga del canvas delle corse e alla pagina.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codiceDaTag, etichettaCodice, urlCodice, repoDelCodice, etichetteCron, piegaReaper } from '../shared/codice.js'
import { statoCron, statoReaper, contaCron } from '../shared/cron.js'
import { codiceConfig, vestiCron } from '../server/codice.js'
import { corseConfig, squadraCron, divideInfra, conInfra, rigaCorsa, canvasCorse, canvasCorseDaScrivere, TUTTI } from '../server/notify/corse.js'
import { regoleSquadre, nomeBreve } from '../server/notify/quadro.js'
import { nomeCron, avvisoReaper } from '../web/rilasci.js'
import { makeT } from '../server/i18n.js'

const ORA = Date.parse('2026-10-03T12:00:00Z')
const DG = 'https://dg.example.com'
const t = makeT('it')
const ESTERNO = 'https://github.com/acme-upstream/terraform-acme-runner/tree/v7.4.0/lambdas/functions'
const ok = (startedAt = '2026-10-03T11:00:00Z', ms = 240_000) => ({ outcome: 'ok', startedAt: Date.parse(startedAt), endedAt: Date.parse(startedAt) + ms, durationMs: ms })
const fallita = (exitCode = 1) => ({ outcome: 'failed', exitCode, startedAt: ORA - 3_600_000, endedAt: ORA - 3_000_000 })
const cron = (account, name, extra = {}) => ({
  key: `${account}/${name}`,
  name,
  account,
  type: 'lambda',
  function: name,
  enabled: true,
  nextRunAt: Date.parse('2026-10-03T13:00:00Z'),
  runs: [ok()],
  ...extra,
})

// ── Il tag ───────────────────────────────────────────────────────────────────────────────────────

test('codiceDaTag: la lista di ECS e la mappa di Lambda, nome del tag senza badare alle maiuscole', () => {
  assert.equal(codiceDaTag([{ key: 'deployedBy', value: 'x' }, { key: 'Codice', value: 'acme-crons/email-clienti' }]), 'acme-crons/email-clienti')
  assert.equal(codiceDaTag({ Codice: ' Backend/cron_aggiornamenti/ ' }), 'Backend/cron_aggiornamenti')
  assert.equal(codiceDaTag({ codice: 'acme-crons/x' }), 'acme-crons/x')
  // Assente o vuoto: il cron tiene il nome di oggi.
  assert.equal(codiceDaTag({ Team: 'data' }), null)
  assert.equal(codiceDaTag({ Codice: '  ' }), null)
  assert.equal(codiceDaTag([]), null)
  assert.equal(codiceDaTag(undefined), null)
})

// ── Etichetta e link ─────────────────────────────────────────────────────────────────────────────

test('etichettaCodice: `<repo>/<percorso>` com’è, un indirizzo di GitHub senza schema, host e `tree/<ref>`', () => {
  assert.equal(etichettaCodice('acme-crons/email-clienti'), 'acme-crons/email-clienti')
  assert.equal(etichettaCodice('acme-scraper/scripts/portal_canary.py'), 'acme-scraper/scripts/portal_canary.py')
  assert.equal(etichettaCodice(ESTERNO), 'acme-upstream/terraform-acme-runner/lambdas/functions')
  assert.equal(etichettaCodice('https://github.com/acme-upstream/modulo/blob/main/src/a.py'), 'acme-upstream/modulo/src/a.py')
  // Un indirizzo che non è di GitHub perde solo lo schema.
  assert.equal(etichettaCodice('https://git.example.org/gruppo/progetto'), 'git.example.org/gruppo/progetto')
  assert.equal(etichettaCodice(null), null)
})

test('urlCodice: `<repo>/<percorso>` → GitHub solo con l’organizzazione; un indirizzo intero com’è', () => {
  assert.equal(urlCodice('acme-crons/email-clienti', { org: 'acme' }), 'https://github.com/acme/acme-crons/tree/main/email-clienti')
  assert.equal(urlCodice('Backend/cron_aggiornamenti', { org: 'acme', ref: 'staging' }), 'https://github.com/acme/Backend/tree/staging/cron_aggiornamenti')
  assert.equal(urlCodice('acme-scraper/scripts/portal canary.py', { org: 'acme' }), 'https://github.com/acme/acme-scraper/tree/main/scripts/portal%20canary.py')
  // Senza organizzazione nessun link: il nome dell'organizzazione nel codice non c'è.
  assert.equal(urlCodice('acme-crons/email-clienti', {}), null)
  assert.equal(urlCodice('acme-crons/email-clienti'), null)
  // Un indirizzo intero non ha bisogno dell'organizzazione e non la usa.
  assert.equal(urlCodice(ESTERNO, { org: 'acme' }), ESTERNO)
  assert.equal(urlCodice(ESTERNO), ESTERNO)
  // Solo http(s): un tag scritto male non diventa un link che esegue qualcosa.
  assert.ok(String(urlCodice('javascript:alert(1)', { org: 'acme' })).startsWith('https://github.com/acme/'))
  assert.ok(!String(urlCodice('javascript:alert(1)', { org: 'acme' })).startsWith('javascript:'))
  assert.equal(urlCodice('javascript:alert(1)'), null)
})

test('codiceConfig: organizzazione facoltativa, ramo di default `main`', () => {
  assert.deepEqual(codiceConfig({}), { org: null, ref: 'main' })
  assert.deepEqual(codiceConfig({ DADAGUARD_GITHUB_ORG: ' acme ', DADAGUARD_GITHUB_REF: 'release' }), { org: 'acme', ref: 'release' })
})

test('repoDelCodice: il primo segmento, o il repository di un indirizzo di GitHub', () => {
  assert.equal(repoDelCodice('acme-crons/email-clienti'), 'acme-crons')
  assert.equal(repoDelCodice(ESTERNO), 'terraform-acme-runner')
  assert.equal(repoDelCodice('https://git.example.org/gruppo/progetto'), null)
  assert.equal(repoDelCodice(null), null)
})

// ── Distinzione ──────────────────────────────────────────────────────────────────────────────────

test('etichetteCron: due job sullo stesso script si distinguono col nome del job, solo nello stesso account', () => {
  const crons = [
    cron('production', 'acme-production-aggiorna-gare', { codice: 'Backend/cron_aggiornamenti' }),
    cron('production', 'acme-production-aggiorna-lotti', { codice: 'Backend/cron_aggiornamenti' }),
    cron('production', 'acme-production-email-clienti', { codice: 'acme-crons/email-clienti' }),
    // Lo stesso cron in staging: stesso Codice per costruzione, ma in un altro account.
    cron('staging', 'acme-staging-email-clienti', { codice: 'acme-crons/email-clienti' }),
    cron('production', 'acme-production-senza-tag'),
  ]
  const e = etichetteCron(crons, { nome: (c) => c.name, breve: (c) => nomeBreve(c.name) })
  assert.equal(e.get('production/acme-production-aggiorna-gare'), 'Backend/cron_aggiornamenti · aggiorna-gare')
  assert.equal(e.get('production/acme-production-aggiorna-lotti'), 'Backend/cron_aggiornamenti · aggiorna-lotti')
  assert.equal(e.get('production/acme-production-email-clienti'), 'acme-crons/email-clienti')
  assert.equal(e.get('staging/acme-staging-email-clienti'), 'acme-crons/email-clienti')
  // Senza tag, il nome di oggi.
  assert.equal(e.get('production/acme-production-senza-tag'), 'acme-production-senza-tag')
})

// ── Reaper ───────────────────────────────────────────────────────────────────────────────────────

test('piegaReaper: `<job>-reaper` entra nella riga del suo job nello stesso account; senza job resta una riga', () => {
  const job = cron('production', 'acme-production-scraper', { type: 'ecs-scheduled', function: undefined, family: 'acme-production-scraper' })
  const reaper = cron('production', 'acme-production-scraper-reaper')
  const orfano = cron('production', 'acme-production-vecchio-reaper')
  // Il job c'è solo in staging: il reaper di produzione non ci si piega.
  const altroAccount = cron('production', 'acme-production-solo-staging-reaper')
  const jobStaging = cron('staging', 'acme-staging-solo-staging')
  const out = piegaReaper([job, reaper, orfano, altroAccount, jobStaging], { breve: nomeBreve })
  assert.deepEqual(out.map((c) => c.key), [job.key, orfano.key, altroAccount.key, jobStaging.key])
  assert.equal(out[0].reaper, reaper)
  // L'ingresso non si tocca.
  assert.equal(job.reaper, undefined)
  // Il job si trova anche dalla famiglia della task definition, quando lo schedule si chiama diverso.
  const perFamiglia = piegaReaper(
    [cron('production', 'acme-production-notturno', { family: 'acme-production-cron-pulizia' }), cron('production', 'acme-production-pulizia-reaper')],
    { breve: nomeBreve },
  )
  assert.equal(perFamiglia.length, 1)
  assert.equal(perFamiglia[0].reaper.name, 'acme-production-pulizia-reaper')
})

test('statoCron col reaper: un reaper fallito o fermo si vede sulla riga del job, uno sano no', () => {
  const job = (reaperRuns, extra = {}) => cron('production', 'j', { reaper: cron('production', 'j-reaper', { runs: reaperRuns }), ...extra })
  assert.equal(statoCron(job([ok()])), 'ok')
  assert.equal(statoCron(job([fallita()])), 'crit')
  assert.equal(statoReaper(job([fallita()])), 'crit')
  // Reaper non partito: arancio, come un cron non partito.
  assert.equal(statoCron(job([])), 'warn')
  // In corso: non è un problema.
  assert.equal(statoCron(job([{ running: true, outcome: 'running', startedAt: ORA - 1000 }])), 'ok')
  // Il job fallito resta fallito, anche col reaper a posto.
  assert.equal(statoCron(job([ok()], { runs: [fallita()] })), 'crit')
  // Un job spento non ha corse da fermare: il suo reaper fermo non lo accende.
  assert.equal(statoCron(job([], { enabled: false, runs: [] })), 'off')
  // Il verdetto conta la riga una volta sola.
  assert.deepEqual(contaCron([job([fallita()])]), { totale: 1, falliti: 1, nonPartiti: 0, inCorso: 0 })
})

// ── La lista per la pagina ───────────────────────────────────────────────────────────────────────

test('vestiCron: etichetta, link al codice, reaper dentro; la chiave non cambia', () => {
  const crons = [
    cron('production', 'acme-production-email-clienti', { codice: 'acme-crons/email-clienti' }),
    cron('production', 'acme-production-email-clienti-reaper', { codice: 'acme-crons/email-clienti' }),
    cron('production', 'acme-production-runner-scale-up', { codice: ESTERNO }),
    cron('production', 'acme-production-ssm-housekeeper'),
  ]
  const out = vestiCron(crons, { org: 'acme', ref: 'main' })
  assert.deepEqual(out.map((c) => c.key), ['production/acme-production-email-clienti', 'production/acme-production-runner-scale-up', 'production/acme-production-ssm-housekeeper'])
  assert.equal(out[0].etichetta, 'acme-crons/email-clienti')
  assert.equal(out[0].codiceUrl, 'https://github.com/acme/acme-crons/tree/main/email-clienti')
  assert.equal(out[0].reaper.etichetta, 'acme-crons/email-clienti · reaper')
  assert.equal(out[0].reaper.key, 'production/acme-production-email-clienti-reaper')
  assert.equal(out[1].etichetta, 'acme-upstream/terraform-acme-runner/lambdas/functions')
  assert.equal(out[1].codiceUrl, ESTERNO)
  // Senza tag: il nome di oggi, nessun link.
  assert.equal(out[2].etichetta, 'acme-production-ssm-housekeeper')
  assert.equal(out[2].codiceUrl, null)
  // Senza organizzazione il percorso resta, il link no.
  assert.equal(vestiCron(crons, { org: null, ref: 'main' })[0].codiceUrl, null)
})

test('pagina: il nome in vista e l’avviso del reaper guasto', () => {
  assert.equal(nomeCron({ name: 'acme-production-x', etichetta: 'acme-crons/x' }), 'acme-crons/x')
  assert.equal(nomeCron({ name: 'acme-production-x' }), 'acme-production-x')
  const tw = (k, v = {}) => ({ 'rilasci.cron.reaperGuasto': `Reaper: ${v.stato} · ${v.motivo}`, 'rilasci.cron.stato.crit': 'Fallito', 'rilasci.cron.stato.warn': 'Non partito', 'runs.exit': `exit ${v.code}` })[k] ?? k
  const job = (reaperRuns) => cron('production', 'j', { reaper: cron('production', 'j-reaper', { runs: reaperRuns }) })
  assert.equal(avvisoReaper(job([fallita(2)]), tw), 'Reaper: Fallito · exit 2')
  assert.equal(avvisoReaper(job([]), tw), 'Reaper: Non partito')
  assert.equal(avvisoReaper(job([ok()]), tw), null)
  assert.equal(avvisoReaper(cron('production', 'j'), tw), null)
})

// ── Squadre e infra ──────────────────────────────────────────────────────────────────────────────

test('squadraCron: il repository del Codice vale come quello dell’immagine', () => {
  const regole = regoleSquadre({ data: ['acme-scraper'], infra: ['terraform-acme-runner', 'ssm-*'] })
  assert.equal(squadraCron({ name: 'acme-production-canary', codice: 'acme-scraper/scripts/portal_canary.py' }, regole), 'data')
  assert.equal(squadraCron({ name: 'acme-production-runner-scale-up', codice: ESTERNO }, regole), 'infra')
  assert.equal(squadraCron({ name: 'acme-production-ssm-housekeeper' }, regole), 'infra')
  assert.equal(squadraCron({ name: 'acme-production-email-clienti', codice: 'acme-crons/email-clienti' }, regole), undefined)
})

test('corseConfig: la squadra infra vale solo se è definita', () => {
  assert.equal(corseConfig({ DADAGUARD_QUADRO_SQUADRE: 'infra=ssm-*' }).infra, 'infra')
  assert.equal(corseConfig({ DADAGUARD_QUADRO_SQUADRE: 'data=acme-scraper' }).infra, null)
  assert.equal(corseConfig({ DADAGUARD_QUADRO_SQUADRE: 'piattaforma=ssm-*', DADAGUARD_CORSE_INFRA: 'Piattaforma' }).infra, 'piattaforma')
})

test('divideInfra e conInfra: i cron infra a parte, nessuno perso, niente senza squadra', () => {
  const squadre = { infra: ['ssm-*'] }
  const crons = [cron('production', 'acme-production-ssm-housekeeper'), cron('production', 'acme-production-email-clienti')]
  const d = divideInfra(crons, squadre, 'infra')
  assert.deepEqual(d.infra.map((c) => c.name), ['acme-production-ssm-housekeeper'])
  assert.deepEqual(d.prodotto.map((c) => c.name), ['acme-production-email-clienti'])
  assert.deepEqual(divideInfra(crons, squadre, null).infra, [])
  const ov = conInfra({ crons }, { squadre, infra: 'infra' })
  assert.deepEqual(ov.crons.map((c) => Boolean(c.infra)), [true, false])
  assert.equal(conInfra({ crons }, { squadre, infra: null }).crons[0].infra, undefined)
})

// ── Il canvas ────────────────────────────────────────────────────────────────────────────────────

test('rigaCorsa: il nome porta alla pagina Cron, il codice ha il suo link accanto; il reaper si dice solo se è guasto', () => {
  const c = cron('production', 'acme-production-email-clienti', {
    etichetta: 'acme-crons/email-clienti',
    codiceUrl: 'https://github.com/acme/acme-crons/tree/main/email-clienti',
  })
  const r = rigaCorsa(c, { ora: ORA, url: DG, t })
  assert.equal(r.nome, 'acme-crons/email-clienti')
  assert.equal(
    r.celle[0],
    `[**acme-crons/email-clienti**](${DG}/cron?cron=production%2Facme-production-email-clienti) · [codice](https://github.com/acme/acme-crons/tree/main/email-clienti)`,
  )
  // Senza etichetta né link: la riga di prima.
  assert.equal(rigaCorsa(cron('production', 'acme-production-cron-report'), { ora: ORA, t }).celle[0], '**report**')

  const conReaper = (runs) => rigaCorsa({ ...c, reaper: cron('production', 'acme-production-email-clienti-reaper', { runs }) }, { ora: ORA, t })
  assert.equal(conReaper([ok()]).celle[2], 'Ok oggi 13:00, 4 min')
  const guasto = conReaper([fallita(3)])
  assert.equal(guasto.stato, 'crit')
  assert.equal(guasto.celle[1], '❌ Fallito')
  assert.equal(guasto.celle[2], 'Ok oggi 13:00, 4 min · reaper: Fallito oggi 13:00 · exit 3')
})

test('canvasCorse: etichette del SUO elenco, e i cron infra in sezioni «Infra» in fondo, contati nel verdetto', () => {
  const crons = [
    cron('production', 'acme-production-aggiorna-gare', { type: 'ecs-scheduled', codice: 'Backend/cron_aggiornamenti' }),
    cron('production', 'acme-production-aggiorna-lotti', { type: 'ecs-scheduled', codice: 'Backend/cron_aggiornamenti' }),
    cron('production', 'acme-production-ssm-housekeeper', { runs: [fallita()] }),
    cron('production', 'acme-production-runner-scale-up', { codice: ESTERNO }),
    cron('staging', 'acme-staging-ssm-housekeeper'),
  ]
  const squadre = { infra: ['terraform-acme-runner', 'ssm-*'] }
  const c = canvasCorse(TUTTI, crons, { ora: ORA, t, squadre, infra: 'infra' })
  assert.deepEqual(c.modello.sezioni.map((s) => s.titolo), ['Riepilogo', 'Produzione', 'Infra · Produzione', 'Infra · Staging'])
  // Due job sullo stesso script: distinti col nome breve del job.
  assert.deepEqual(
    c.modello.sezioni[1].righe.map((r) => r[0]),
    ['**Backend/cron_aggiornamenti · aggiorna-gare**', '**Backend/cron_aggiornamenti · aggiorna-lotti**'],
  )
  // Senza tag, il nome breve; un indirizzo esterno nella sua forma corta.
  assert.deepEqual(c.modello.sezioni[2].righe.map((r) => r[0]), ['**acme-upstream/terraform-acme-runner/lambdas/functions**', '**ssm-housekeeper**'])
  // Il verdetto conta anche gli infra, e «Da guardare» li nomina.
  assert.equal(c.conti.totale, 5)
  assert.equal(c.conti.falliti, 1)
  assert.match(c.modello.sezioni[0].fondo, /❌ ssm-housekeeper \(PROD\)/)

  // Senza squadra infra, nessuna sezione a parte.
  assert.deepEqual(canvasCorse(TUTTI, crons, { ora: ORA, t }).modello.sezioni.map((s) => s.titolo), ['Riepilogo', 'Produzione', 'Staging'])
})

test('canvasCorseDaScrivere: le sezioni «Infra» solo nel canvas di tutti', () => {
  const overview = { window: 1440, problems: [], crons: [cron('production', 'acme-production-ssm-housekeeper'), cron('production', 'acme-production-email-clienti')] }
  const cfg = corseConfig({ DADAGUARD_SLACK_BOT_TOKEN: 'xoxb-finto', DADAGUARD_CORSE_CANALI: 'tutti=C0TUTTI,infra=C0INFRA', DADAGUARD_QUADRO_SQUADRE: 'infra=ssm-*' })
  const [tutti, infra] = canvasCorseDaScrivere({ overview, etichette: {} }, cfg, { ora: ORA })
  assert.deepEqual(tutti.modello.sezioni.map((s) => s.titolo), ['Riepilogo', 'Produzione', 'Infra · Produzione'])
  assert.deepEqual(infra.modello.sezioni.map((s) => s.titolo), ['Riepilogo', 'Produzione'])
})
