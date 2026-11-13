import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TAGLIE_FARGATE,
  costoOraTask,
  quotaSpot,
  tagliaGiusta,
  percentile,
  settimanaTipo,
  oreFerme,
  eccessoMinimo,
  nonProduzione,
  classeSotto,
  dbReggeTagliaSotto,
  ordinaLeve,
} from '../server/efficienza/regole.js'
import { prezziFargateDa, prezzoOnDemand, tariffeSpotDa, conSpot } from '../server/efficienza/prezzi.js'
import { dimensioneAlb, suFargate } from '../server/efficienza/ecs.js'
import { leveAccount } from '../server/efficienza/index.js'
import { efficienzaDemo } from '../server/efficienza/demo.js'

const LISTINO = { vcpu: 0.04, gb: 0.004, spotVcpu: 0.012, spotGb: 0.0012 }

test('taglie Fargate: solo combinazioni che AWS accetta', () => {
  assert.ok(TAGLIE_FARGATE.some(([c, m]) => c === 256 && m === 512))
  assert.ok(!TAGLIE_FARGATE.some(([c, m]) => c === 256 && m === 4096)) // 0,25 vCPU arriva a 2 GB
  assert.ok(!TAGLIE_FARGATE.some(([c, m]) => c === 1024 && m === 1024)) // 1 vCPU parte da 2 GB
  assert.ok(TAGLIE_FARGATE.some(([c, m]) => c === 16384 && m === 122880))
})

test('costo orario di un task: listino pieno, Spot e prezzi assenti', () => {
  assert.equal(costoOraTask({ cpu: 1024, memMb: 2048 }, LISTINO), 0.04 + 2 * 0.004)
  const meta = costoOraTask({ cpu: 1024, memMb: 2048, quotaSpot: 0.5 }, LISTINO)
  assert.ok(Math.abs(meta - (0.048 + 0.0144) / 2) < 1e-12)
  assert.equal(costoOraTask({ cpu: 1024, memMb: 2048 }, null), null) // senza prezzi: sconosciuto, non zero
})

test('quota Spot: base prima, poi pesi; nessuna strategia = zero', () => {
  assert.equal(quotaSpot(null, 4), 0)
  assert.equal(quotaSpot([{ capacityProvider: 'FARGATE_SPOT', weight: 1 }], 4), 1)
  // base 1 on-demand, poi 1:3 → su 5 task: 1 + 4 * 0,25 on-demand = 2, Spot 3
  const q = quotaSpot([{ capacityProvider: 'FARGATE', base: 1, weight: 1 }, { capacityProvider: 'FARGATE_SPOT', weight: 3 }], 5)
  assert.equal(q, 3 / 5)
})

test('taglia giusta: scende quando il picco lo permette, resta quando no', () => {
  // 2 vCPU usate al 22% al picco → 0,73 vCPU servono → 1 vCPU (la memoria resta 4 GB perché serve)
  assert.deepEqual(
    (({ cpu, memMb }) => ({ cpu, memMb }))(tagliaGiusta({ cpu: 2048, memMb: 4096, cpuP95: 22, memP95: 48 }, LISTINO)),
    { cpu: 1024, memMb: 4096 },
  )
  // al 94% di CPU la taglia è già giusta
  assert.equal(tagliaGiusta({ cpu: 1024, memMb: 2048, cpuP95: 94, memP95: 81 }, LISTINO), null)
  // dati mancanti: niente proposta
  assert.equal(tagliaGiusta({ cpu: 1024, memMb: 2048, cpuP95: null, memP95: 10 }, LISTINO), null)
})

test('percentile e settimana tipo', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3)
  assert.equal(percentile([], 0.9), null)
  // lunedì 5 gennaio 2026, 10:00 UTC → cella 10
  const s = settimanaTipo([[Date.UTC(2026, 0, 5, 10), 4], [Date.UTC(2026, 0, 12, 10), 6]])
  assert.equal(s[10], 5)
  assert.equal(s[11], null)
})

test('ore ferme: le notti e i weekend di un ambiente da ufficio', () => {
  const settimana = Array.from({ length: 168 }, (_, i) => {
    const g = Math.floor(i / 24)
    const h = i % 24
    return g < 5 && h >= 9 && h < 19 ? 10 : 0.2
  })
  assert.equal(oreFerme(settimana).ore, 168 - 50)
  // meno di una settimana vista: non si giudica
  assert.equal(oreFerme(new Array(168).fill(null)).ore, 0)
})

test('minimo dell autoscaling troppo alto: conta solo le ore al minimo', () => {
  const ore = [
    { task: 2, vcpuUsate: 0.3 }, // al minimo, ne serviva 1 → 1 task-ora sprecata
    { task: 2, vcpuUsate: 2 }, // al minimo, ne servivano 2
    { task: 5, vcpuUsate: 5 }, // stava scalando
  ]
  assert.equal(eccessoMinimo({ minimo: 2, vcpuTask: 2, ore }), (1 * 730) / 3)
  assert.equal(eccessoMinimo({ minimo: 1, vcpuTask: 2, ore }), 0) // minimo 1: niente da togliere
})

test('ambienti: la produzione non si spegne mai', () => {
  assert.equal(nonProduzione('prod'), false)
  assert.equal(nonProduzione('production-eu'), false)
  assert.equal(nonProduzione('staging'), true)
  assert.equal(nonProduzione('dev-sandbox'), true)
  assert.equal(nonProduzione('management'), false) // non si sa: non si propone
})

test('database: classe sotto e quando la regge', () => {
  assert.equal(classeSotto('db.r6g.2xlarge'), 'db.r6g.xlarge')
  assert.equal(classeSotto('db.t4g.micro'), null)
  assert.equal(classeSotto('db.serverless'), null)
  assert.equal(dbReggeTagliaSotto({ cpuP95: 18, memLiberaMin: 58 }), true)
  assert.equal(dbReggeTagliaSotto({ cpuP95: 35, memLiberaMin: 58 }), false) // 70% dopo: troppo
  assert.equal(dbReggeTagliaSotto({ cpuP95: 10, memLiberaMin: 40 }), false) // memoria al 120%
})

test('prezzi Fargate: riconosciuti dal suffisso dello usagetype, qualunque regione', () => {
  const prodotto = (usagetype, usd) =>
    JSON.stringify({
      product: { attributes: { usagetype } },
      terms: { OnDemand: { x: { priceDimensions: { y: { pricePerUnit: { USD: String(usd) } } } } } },
    })
  const p = prezziFargateDa([
    prodotto('XYZ1-Fargate-vCPU-Hours:perCPU', 0.04),
    prodotto('XYZ1-Fargate-GB-Hours', 0.0044),
    prodotto('XYZ1-SpotUsage-vCPU-Hours:perCPU', 0.012),
    prodotto('XYZ1-SpotUsage-GB-Hours', 0.0013),
    prodotto('XYZ1-Fargate-Windows-vCPU-Hours:perCPU', 0.09),
  ])
  // Spot non è nel listino: resta da riempire con la tariffa effettiva
  assert.deepEqual(p.x86, { vcpu: 0.04, gb: 0.0044, spotVcpu: null, spotGb: null })
  assert.equal(p.arm, null)
  assert.equal(prezziFargateDa([prodotto('XYZ1-Fargate-GB-Hours', 0.0044)]), null)
  assert.equal(prezzoOnDemand({ terms: {} }), null)
})

test('ECS: dimensioni CloudWatch del load balancer e servizi su Fargate', () => {
  assert.equal(dimensioneAlb('arn:aws:elasticloadbalancing:eu-west-1:000000000000:loadbalancer/app/fronte/abc123'), 'app/fronte/abc123')
  assert.equal(dimensioneAlb('arn:aws:elasticloadbalancing:eu-west-1:000000000000:targetgroup/api-tg/def456'), 'targetgroup/api-tg/def456')
  assert.equal(suFargate({ launchType: 'FARGATE' }), true)
  assert.equal(suFargate({ launchType: 'EC2' }), false)
  assert.equal(suFargate({ capacityProviderStrategy: [{ capacityProvider: 'FARGATE_SPOT' }] }), true)
  assert.equal(suFargate({ capacityProviderStrategy: [{ capacityProvider: 'mio-asg' }] }), false)
})

test('leve: taglia, Spot per i worker, fuori orario solo fuori produzione', () => {
  const servizio = {
    nome: 'worker', squadra: 'dati', cpu: 2048, memMb: 4096, costoOraTask: 0.096, taskMedi: 2, desiderati: 2, quotaSpot: 0,
    bilanciato: false, pianificato: false, eccessoMinimoTaskOra: 0, listino: LISTINO,
    proposta: { cpu: 1024, memMb: 2048, risparmioOraTask: 0.048 },
  }
  const ufficio = Array.from({ length: 168 }, (_, i) => (Math.floor(i / 24) < 5 && i % 24 >= 9 && i % 24 < 19 ? 4 : 0.1))
  const prod = leveAccount({ account: 'prod', ambienteNonProd: false, servizi: [servizio], settimana: ufficio })
  assert.deepEqual(prod.map((l) => l.tipo).sort(), ['spot', 'taglia'])
  const taglia = prod.find((l) => l.tipo === 'taglia')
  assert.ok(Math.abs(taglia.usdMese - 0.048 * 2 * 730) < 1e-9)
  const stg = leveAccount({ account: 'staging', ambienteNonProd: true, servizi: [{ ...servizio, bilanciato: true }], settimana: ufficio })
  const orari = stg.find((l) => l.tipo === 'orari')
  assert.equal(orari.dati.oreFerme, 118)
  // già pianificato: nessuna proposta di spegnimento
  const pian = leveAccount({ account: 'staging', ambienteNonProd: true, servizi: [{ ...servizio, pianificato: true }], settimana: ufficio })
  assert.equal(pian.find((l) => l.tipo === 'orari'), undefined)
})

test('leve: ordinate per risparmio, briciole fuori', () => {
  const l = ordinaLeve([{ usdMese: 3 }, { usdMese: 0.2 }, { usdMese: 40 }])
  assert.deepEqual(l.map((x) => x.usdMese), [40, 3])
})

test('demo: passa dalle regole vere e produce leve per entrambi gli ambienti', () => {
  const d = efficienzaDemo(30)
  assert.ok(d.leve.length >= 4)
  assert.ok(d.leve.some((l) => l.tipo === 'orari' && l.account === 'staging'))
  assert.ok(!d.leve.some((l) => l.tipo === 'orari' && l.account === 'prod'))
  assert.ok(d.servizi.every((s) => s.orarie === undefined)) // le serie orarie non escono
  assert.equal(d.settimane.prod.length, 168)
})

test('tariffa Spot effettiva: costo diviso ore delle voci Spot, e niente tariffa senza uso', () => {
  const g = (tipo, costo, ore) => ({ Keys: [tipo], Metrics: { UnblendedCost: { Amount: String(costo) }, UsageQuantity: { Amount: String(ore) } } })
  const t = tariffeSpotDa([
    g('XYZ1-SpotUsage-Fargate-vCPU-Hours:perCPU', 12, 1000),
    g('XYZ1-SpotUsage-Fargate-GB-Hours', 2.6, 2000),
    g('XYZ1-Fargate-vCPU-Hours:perCPU', 400, 10000),
    g('XYZ1-SpotUsage-Fargate-EphemeralStorage-GB-Hours', 1, 50),
  ])
  assert.equal(t.vcpu, 0.012)
  assert.equal(t.gb, 0.0013)
  assert.deepEqual(tariffeSpotDa([]), { vcpu: null, gb: null })
  const p = conSpot({ x86: { vcpu: 0.04, gb: 0.004, spotVcpu: null, spotGb: null }, arm: { vcpu: 0.032, gb: 0.0032 } }, t)
  assert.equal(p.x86.spotVcpu, 0.012)
  assert.ok(Math.abs(p.arm.spotVcpu - 0.0096) < 1e-12)
  assert.equal(conSpot(null, t), null)
})

import { leggiUrl, segnaliTabella, opzioniTls } from '../server/efficienza/pgStat.js'
import { databaseFuoriRds } from '../server/efficienza/index.js'

test('Postgres: configurazione id=url, voci malformate scartate', () => {
  assert.deepEqual(leggiUrl(''), [])
  const v = leggiUrl('db-a=postgresql://u:p@h:5432/x; rotto ;prod/db-b=postgres://u@h/y;db-c=mysql://h')
  assert.deepEqual(v.map((x) => x.id), ['db-a', 'db-b'])
  assert.deepEqual(v.map((x) => x.account), [null, 'prod'])
})

test('Postgres: segnali di una tabella con soglie dichiarate', () => {
  const GB = 1024 ** 3
  assert.deepEqual(segnaliTabella({ vive: 70, morte: 30, totale: 2 * GB, heap: GB, letture_intere: 10, letture_indice: 1e6 }), ['morte'])
  assert.deepEqual(segnaliTabella({ vive: 100, morte: 0, totale: 9 * GB, heap: 6 * GB, letture_intere: 5000, letture_indice: 10 }), ['intere'])
  // piccola: non vale la pena
  assert.deepEqual(segnaliTabella({ vive: 1, morte: 9, totale: 1024, heap: 1024, letture_intere: 1e6, letture_indice: 0 }), [])
})

test('leve dentro il database: indici mai usati e righe morte al prezzo del disco', () => {
  const GB = 1024 ** 3
  const db = {
    id: 'main', squadra: null, discoGbMese: 0.1, proposta: null,
    interno: {
      indiciInutili: [{ byte: 2 * GB }, { byte: 2 * GB }],
      tabelle: [{ vive: 50, morte: 50, totale: 10 * GB, heap: 8 * GB, segnali: ['morte'] }],
    },
  }
  const leve = leveAccount({ account: 'prod', ambienteNonProd: false, database: [db] })
  assert.ok(Math.abs(leve.find((l) => l.tipo === 'indici').usdMese - 0.4) < 1e-9)
  assert.ok(Math.abs(leve.find((l) => l.tipo === 'morte').usdMese - 0.5) < 1e-9)
  // senza statistiche interne o senza prezzo del disco: nessuna leva
  assert.equal(leveAccount({ account: 'prod', database: [{ ...db, discoGbMese: null }] }).length, 0)
})

test('listino: i prodotti dell SDK v3 arrivano come JSON pigro, non come stringa', () => {
  // Stessa forma di LazyJsonString: un oggetto che diventa il JSON solo con toString().
  class Pigro {
    constructor(s) { this.s = s }
    toString() { return this.s }
  }
  const prodotto = (usagetype, usd) =>
    new Pigro(JSON.stringify({ product: { attributes: { usagetype } }, terms: { OnDemand: { x: { priceDimensions: { y: { pricePerUnit: { USD: String(usd) } } } } } } }))
  const p = prezziFargateDa([prodotto('XYZ1-Fargate-vCPU-Hours:perCPU', 0.04), prodotto('XYZ1-Fargate-GB-Hours', 0.0044)])
  assert.equal(p.x86.vcpu, 0.04)
  assert.equal(prezzoOnDemand(prodotto('XYZ1-Fargate-GB-Hours', 0.0044)), 0.0044)
})

test('Spot: mai per un servizio con un task solo, e una copia resta on-demand', () => {
  const s = {
    nome: 'tunnel', cpu: 1024, memMb: 2048, costoOraTask: 0.048, taskMedi: 1, desiderati: 1, min: null, max: null,
    quotaSpot: 0, bilanciato: false, pianificato: false, eccessoMinimoTaskOra: 0, listino: LISTINO, proposta: null,
  }
  assert.equal(leveAccount({ account: 'prod', servizi: [s] }).length, 0)
  const tre = leveAccount({ account: 'prod', servizi: [{ ...s, nome: 'consumer', taskMedi: 3, desiderati: 3 }] })
  const spot = costoOraTask({ cpu: 1024, memMb: 2048, quotaSpot: 1 }, LISTINO)
  assert.ok(Math.abs(tre[0].usdMese - (0.048 - spot) * 2 * 730) < 1e-9) // due copie su tre
})

test('Postgres: con la CA si verifica la catena e si tolgono i parametri ssl dell URL', () => {
  const ca = '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----'
  const o = opzioniTls('postgresql://u:p@lb.interno:5432/postgres?sslmode=require&application_name=x', ca)
  assert.ok(!o.connectionString.includes('sslmode'))
  assert.ok(o.connectionString.includes('application_name=x'))
  assert.equal(o.ssl.rejectUnauthorized, true)
  assert.equal(o.ssl.ca, ca)
  assert.equal(o.ssl.checkServerIdentity(), undefined) // verify-ca: il nome del load balancer non è nel certificato
  // senza CA l'URL resta com'è
  assert.deepEqual(opzioniTls('postgresql://h/db?sslmode=require', ''), { connectionString: 'postgresql://h/db?sslmode=require' })
})

test('database fuori da RDS: righe con le sole statistiche, mai doppioni di un RDS', () => {
  const righe = databaseFuoriRds({ 'pg-ec2': { account: 'prod', db: { connessioni: 40, limite: 300 } }, 'rds-1': { account: null } }, [{ id: 'rds-1' }])
  assert.equal(righe.length, 1)
  assert.equal(righe[0].id, 'pg-ec2')
  assert.equal(righe[0].account, 'prod')
  assert.equal(righe[0].fuoriRds, true)
  assert.equal(righe[0].usdMese, null)
  assert.equal(righe[0].connessioniLimite, 300)
})

import { eHostElb, contoDb } from '../server/efficienza/dbSuEc2.js'

test('database su EC2: si risale solo da un host di load balancer AWS', () => {
  assert.equal(eHostElb('db-writer-abc123.elb.eu-west-1.amazonaws.com'), true)
  assert.equal(eHostElb('db.interno.example'), false)
  assert.equal(eHostElb('10.0.0.5'), false)
})

test('database su EC2: costo delle istanze più i dischi, e il disco dei dati è il più grande', () => {
  const c = contoDb({
    nodi: [{ id: 'i-1', tipo: 'r7g.xlarge', volumi: ['v-1', 'v-2'] }, { id: 'i-2', tipo: 'r7g.xlarge', volumi: ['v-3', 'v-4'] }],
    volumi: { 'v-1': { gb: 30, tipo: 'gp2' }, 'v-2': { gb: 500, tipo: 'gp3' }, 'v-3': { gb: 30, tipo: 'gp2' }, 'v-4': { gb: 500, tipo: 'gp3' } },
    prezzi: { istanza: { 'r7g.xlarge': 0.25 }, disco: { gp3: 0.1, gp2: 0.12 } },
  })
  assert.equal(c.repliche, 2)
  assert.equal(c.classe, 'r7g.xlarge')
  assert.equal(c.tipoDisco, 'gp3')
  assert.equal(c.discoGbMese, 0.1)
  assert.ok(Math.abs(c.usdMese - (2 * 0.25 * 730 + 1000 * 0.1 + 60 * 0.12)) < 1e-9)
  // un prezzo che manca: il totale è sconosciuto, non un numero sbagliato
  assert.equal(contoDb({ nodi: [{ tipo: 'x', volumi: [] }], volumi: {}, prezzi: { istanza: {}, disco: {} } }).usdMese, null)
  assert.equal(contoDb({ nodi: [] }), null)
})

test('leve dentro un database replicato: lo spazio sprecato si paga una volta per copia', () => {
  const GB = 1024 ** 3
  const db = { id: 'pg', discoGbMese: 0.1, repliche: 2, proposta: null, interno: { indiciInutili: [{ byte: 10 * GB }], tabelle: [] } }
  const l = leveAccount({ account: 'prod', database: [db] })
  assert.ok(Math.abs(l[0].usdMese - 10 * 0.1 * 2) < 1e-9)
})
