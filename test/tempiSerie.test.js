// Le serie della pagina Tempi: fasce sbagliate spostano un rilascio di giorno, una durata presa da una
// build fallita fa sembrare il rilascio piu' veloce, e piccoli multipli con una scala per riga
// disegnano la stessa collina per un servizio da 40 secondi e uno da 12 minuti.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodeBuildClient } from '@aws-sdk/client-codebuild'
import { griglia, serieTempi, kpiTempi, perServizio, quantile } from '../shared/tempiSerie.js'
import { puntiBuild, tempiPerServizio } from '../server/tempiDeploy.js'
import { demoStoricoDeploy } from '../server/demo.js'
import { storicoBuilds } from '../server/deploys.js'

const ORA = new Date(2026, 9, 20, 15, 30).getTime()
const G = 86_400_000
const MIN = 60_000

test('griglia: fasce di un giorno da mezzanotte locale (sei ore sulla settimana), l’ultima contiene adesso', () => {
  const g = griglia({ giorni: 30, ora: ORA })
  assert.equal(g.punti, 30)
  assert.equal(g.passoMs, G)
  assert.equal(new Date(g.inizio).getHours(), 0)
  assert.ok(ORA >= g.inizio + 29 * G && ORA < g.inizio + 30 * G)
  const s = griglia({ giorni: 7, ora: ORA })
  assert.equal(s.punti, 28)
  assert.equal(new Date(s.inizio + s.punti * s.passoMs).getHours(), 18, 'le 15:30 stanno nella fascia 12-18')
})

test('serie: durate solo dalle riuscite, conteggi da tutte; fascia vuota = buco nelle durate, zero nei conteggi', () => {
  const g = griglia({ giorni: 7, ora: ORA })
  const t0 = g.inizio + 27 * g.passoMs + MIN
  const p = (extra) => ({ a: 'prod', s: 'api', t: t0, esito: 'ok', ci: 4 * MIN, attesa: MIN, coda: 30_000, build: 2 * MIN, deploy: MIN, totale: 4 * MIN, lead: 9 * MIN, ...extra })
  const s = serieTempi([p(), p({ build: 4 * MIN, totale: 6 * MIN, lead: 11 * MIN }), p({ esito: 'ko', build: 10_000, totale: 40_000 })], g)
  const pz = Object.fromEntries(s.pezzi.map((x) => [x.k, x.valori]))
  assert.equal(pz.build[27], 3 * MIN, 'la fallita da 10 secondi non abbassa la mediana')
  assert.equal(pz.attese[27], 90_000, 'attese = attesa GitHub + coda CodeBuild')
  assert.equal(s.totale.p50[27], 5 * MIN)
  assert.equal(s.riusciti[27], 2)
  assert.equal(s.falliti[27], 1)
  assert.equal(s.totale.p50[0], null)
  assert.equal(s.riusciti[0], 0)
  const k = kpiTempi([p(), p({ esito: 'ko' })], { giorni: 7 })
  assert.deepEqual(k.falliti, { n: 1, tot: 2, tasso: 0.5 })
  assert.equal(k.alGiorno, 1 / 7)
  assert.equal(k.attese.p50, 90_000)
})

test('piccoli multipli: dal servizio con più rilasci, una scala sola, il resto contato', () => {
  const g = griglia({ giorni: 7, ora: ORA })
  const t = g.inizio + g.passoMs
  const punti = [
    ...Array.from({ length: 3 }, () => ({ a: 'prod', s: 'lento', t, esito: 'ok', totale: 12 * MIN })),
    { a: 'prod', s: 'veloce', t, esito: 'ok', totale: 40_000 },
    { a: 'prod', s: 'raro', t, esito: 'ok', totale: MIN },
  ]
  const m = perServizio(punti, g, { max: 2 })
  assert.deepEqual(m.righe.map((r) => r.servizio), ['lento', 'raro'], 'a parità di rilasci, in ordine di nome')
  assert.deepEqual(m.dominio, [0, 12 * MIN])
  assert.equal(m.altri, 1)
  assert.equal(quantile([1, 3], 0.5), 2)
})

test('demo: lo storico finto è deterministico e passa dallo stesso codice di quello vero', () => {
  const a = demoStoricoDeploy(30, ORA)
  const b = demoStoricoDeploy(30, ORA)
  const pa = puntiBuild(a.perAccount, a)
  assert.deepEqual(pa, puntiBuild(b.perAccount, b))
  assert.ok(pa.length > 100)
  assert.ok(pa.some((p) => p.esito === 'ko'))
  // Quasi tutte: un commit di staging promosso due volte in produzione ha due run sullo stesso sha, e
  // per la seconda build il primo run e' di ore prima (fuori dal tetto di tre ore), come nel vero.
  const ok = pa.filter((p) => p.esito === 'ok')
  const conCi = ok.filter((p) => p.ci > 0 && p.attesa > 0 && p.lead > p.totale)
  assert.ok(conCi.length / ok.length > 0.9, `CI, attesa e lead su quasi ogni riuscita (${conCi.length}/${ok.length})`)
  const righe = tempiPerServizio(a.perAccount, a)
  assert.ok(righe.some((r) => r.daStaging), 'qualche commit promosso da staging')
})

test('storico CodeBuild: pagine finché si resta nella finestra, la prima pagina più vecchia è l’ultima', async () => {
  const ora = Date.now()
  const build = (id, fa) => ({ id, projectName: 'acme-production-api-deploy', buildNumber: id, buildStatus: 'SUCCEEDED', startTime: new Date(ora - fa), endTime: new Date(ora - fa + MIN), phases: [] })
  const pagine = { undefined: { ids: ['1', '2'], nextToken: 'p2' }, p2: { ids: ['3', '4'], nextToken: 'p3' }, p3: { ids: ['5'] } }
  const vecchie = { 1: G, 2: 2 * G, 3: 5 * G, 4: 9 * G, 5: 20 * G }
  const chiamate = []
  const prima = CodeBuildClient.prototype.send
  CodeBuildClient.prototype.send = async function (cmd) {
    const nome = cmd.constructor.name
    chiamate.push(nome)
    if (nome === 'ListProjectsCommand') return { projects: ['acme-production-api-deploy', 'altro-progetto'] }
    if (nome === 'ListBuildsForProjectCommand') {
      // Come CodeBuild vero: `sortOrder` insieme a `nextToken` è un errore.
      if (cmd.input.nextToken && cmd.input.sortOrder) throw new Error("Sort order can't be specified when passing a nextToken.")
      return pagine[cmd.input.nextToken]
    }
    if (nome === 'BatchGetBuildsCommand') return { builds: cmd.input.ids.map((id) => build(Number(id), vecchie[id])) }
    throw new Error(nome)
  }
  try {
    const { builds } = await storicoBuilds({ region: 'eu-west-1' }, { giorni: 7 })
    assert.deepEqual(builds.map((b) => b.number), [1, 2, 3])
    assert.equal(chiamate.filter((c) => c === 'ListBuildsForProjectCommand').length, 2, 'la terza pagina non si chiede')
  } finally {
    CodeBuildClient.prototype.send = prima
  }
})
