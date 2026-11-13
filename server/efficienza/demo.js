import { costoOraTask, quotaSpot, tagliaGiusta, percentile, eccessoMinimo, ORE_MESE } from './regole.js'
import { leveAccount, settimanaAccount, TAG_SQUADRA } from './index.js'
import { segnaliTabella } from './pgStat.js'

// Efficienza in modalità demo: una flotta inventata (due ambienti, otto servizi, due database) fatta
// passare dalle STESSE regole del server, così la demo mostra proposte e leve calcolate davvero e non
// numeri scritti a mano che divergono dalla logica al primo cambio.

const LISTINO = { vcpu: 0.04048, gb: 0.004445, spotVcpu: 0.01279, spotGb: 0.0014 }
const ORA = 3600000

// Rumore deterministico: la demo deve dare gli stessi numeri a ogni apertura.
function rumore(i) {
  const x = Math.sin(i * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

// Carico orario 0..1: `ufficio` lavora nei giorni feriali dalle 9 alle 19 (UTC), `continuo` sempre
// con una valle di notte, `notturno` solo fra l'1 e le 4.
function carico(forma, t, i) {
  const d = new Date(t)
  const g = (d.getUTCDay() + 6) % 7
  const h = d.getUTCHours()
  const r = rumore(i) * 0.15
  if (forma === 'ufficio') return g < 5 && h >= 9 && h < 19 ? 0.55 + r : 0.03 + r * 0.1
  if (forma === 'notturno') return h >= 1 && h < 4 ? 0.85 + r : 0
  return (h >= 8 && h < 22 ? 0.7 : 0.3) * (g < 5 ? 1 : 0.6) + r
}

const FLOTTA = [
  // account, nome, cpu, mem, attivi, min, max, carico CPU al picco (%), memoria al picco (%), forma, LB, spot, squadra, richieste/ora al picco
  ['prod', 'api', 2048, 4096, 3, 2, 8, 24, 48, 'continuo', true, null, 'product', 52000],
  ['prod', 'web', 1024, 2048, 2, null, null, 43, 19, 'continuo', true, null, 'product', 9000],
  ['prod', 'worker-ocr', 1024, 2048, 6, 1, 6, 96, 81, 'continuo', false, 'spot', 'data', null],
  ['prod', 'worker-import', 512, 2048, 4, 1, 10, 70, 24, 'continuo', false, 'spot', 'data', null],
  ['prod', 'report-nightly', 2048, 8192, 1, null, null, 60, 35, 'notturno', false, null, 'data', null],
  ['staging', 'api', 1024, 2048, 2, null, null, 30, 40, 'ufficio', true, null, 'product', 900],
  ['staging', 'web', 512, 1024, 1, null, null, 35, 45, 'ufficio', true, null, 'product', 300],
  ['staging', 'worker-import', 512, 1024, 1, null, null, 50, 50, 'ufficio', false, 'spot', 'data', null],
]

function servizio(riga, giorni, fine) {
  const [account, nome, cpu, memMb, attivi, min, max, cpuPicco, memPicco, forma, bilanciato, spot, squadra, reqOra] = riga
  const strategia = spot ? [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }] : null
  const quota = quotaSpot(strategia, attivi)
  const vcpu = cpu / 1024
  const ore = giorni * 24
  const orarie = []
  const cpuP = []
  const memP = []
  let richieste = 0
  for (let k = 0; k < ore; k++) {
    const t = fine - (ore - k) * ORA
    const c = carico(forma, t, k + nome.length * 31)
    // Un servizio che scala tiene più task quando il carico sale; uno fisso ne tiene sempre `attivi`.
    const task = min != null ? Math.max(min, Math.min(max, Math.round(attivi * c * 1.4))) : forma === 'notturno' ? (c > 0 ? 1 : 0) : attivi
    const cpuPct = Math.min(100, cpuPicco * c)
    orarie.push([t, (task * vcpu * cpuPct) / 100, task])
    cpuP.push(Math.min(100, cpuPct * 1.1))
    memP.push(Math.min(100, memPicco * (0.85 + c * 0.15)))
    if (reqOra) richieste += reqOra * c
  }
  const taskMedi = orarie.reduce((a, o) => a + o[2], 0) / ore
  const costoOra = costoOraTask({ cpu, memMb, quotaSpot: quota }, LISTINO)
  const recenti = (l) => l.slice(-14 * 24)
  const cpuP95 = percentile(recenti(cpuP), 0.95)
  const memP95 = percentile(recenti(memP), 0.95)
  const giornaliero = new Map()
  for (const [t, usate, task] of orarie) {
    const g = new Date(t).toISOString().slice(0, 10)
    const d = giornaliero.get(g) ?? { giorno: g, pagate: 0, usate: 0 }
    d.pagate += task * vcpu
    d.usate += usate
    giornaliero.set(g, d)
  }
  return {
    account,
    cluster: account === 'prod' ? 'apps' : 'apps-staging',
    nome,
    squadra,
    cpu,
    memMb,
    arch: 'x86',
    desiderati: attivi,
    attivi,
    taskMedi,
    taskStimati: false,
    quotaSpot: quota,
    bilanciato,
    min,
    max,
    pianificato: false,
    cpuP95,
    memP95,
    costoOraTask: costoOra,
    usdMese: costoOra * taskMedi * ORE_MESE,
    proposta: tagliaGiusta({ cpu, memMb, cpuP95, memP95 }, LISTINO),
    eccessoMinimoTaskOra: min ? eccessoMinimo({ minimo: min, vcpuTask: vcpu, ore: orarie.map(([t, v, task]) => ({ t, task, vcpuUsate: v })) }) : 0,
    richieste: reqOra ? Math.round(richieste) : null,
    giornaliero: [...giornaliero.values()],
    orarie: orarie.map(([t, v]) => [t, v]),
    listino: LISTINO,
  }
}

// Le statistiche interne di Postgres del database inventato (con `pg_read_all_stats`).
function internoDemo() {
  const GB = 1024 ** 3
  const tab = (schema, tabella, gb, heap, vive, morte, intere, indice, giorni) => ({
    schema, tabella, totale: gb * GB, heap: heap * GB, vive, morte, letture_intere: intere, letture_indice: indice,
    ultimo_vacuum: new Date(Date.UTC(2026, 9, 20 - giorni)).toISOString(),
  })
  const tabelle = [
    tab('public', 'documents', 41, 26, 38e6, 0.8e6, 126000, 310000, 0),
    tab('audit', 'events', 29, 22, 96e6, 0, 40, 9e6, 1),
    tab('public', 'sessions', 12, 9, 4.1e6, 1.85e6, 12, 8e6, 4),
    tab('public', 'items', 9.4, 6, 61e6, 0.6e6, 30, 4e7, 0),
  ]
  return {
    db: { memoria: 0.996, connessioni: 64, in_attesa: 2, limite: 400, dimensione: 184 * GB, dal: '2026-09-01T00:00:00Z' },
    schemi: [
      { schema: 'public', tabelle: 148, righe: 290e6, heap: 64 * GB, indici: 48 * GB, toast: 20 * GB },
      { schema: 'audit', tabelle: 9, righe: 98e6, heap: 26 * GB, indici: 6 * GB, toast: 2 * GB },
      { schema: 'staging_area', tabelle: 55, righe: 22e6, heap: 9 * GB, indici: 5 * GB, toast: 4 * GB },
    ],
    tabelle: tabelle.map((t) => ({ ...t, segnali: segnaliTabella(t) })),
    indiciInutili: [
      { schema: 'audit', tabella: 'events', indice: 'events_payload_idx', byte: 2.1 * GB },
      { schema: 'public', tabella: 'documents', indice: 'documents_old_status_idx', byte: 1.4 * GB },
      { schema: 'public', tabella: 'items', indice: 'items_legacy_code_idx', byte: 0.9 * GB },
    ],
  }
}

const DATABASE = [
  {
    account: 'prod', id: 'main-db', cluster: null, motore: 'postgres', versione: '16.4', classe: 'db.r6g.2xlarge', vcpu: 8, memGb: 64,
    multiAz: true, replica: false, discoGb: 400, squadra: 'product', cpuP95: 18.2, memLiberaMin: 58.4, connessioniMax: 64, connessioniLimite: null,
    usdMese: 1.672 * ORE_MESE, proposta: { classe: 'db.r6g.xlarge', usdMese: 0.836 * ORE_MESE, risparmio: 0.836 * ORE_MESE },
    tipoDisco: 'gp3', discoGbMese: 0.274, interno: internoDemo(),
  },
  {
    account: 'staging', id: 'main-db-staging', cluster: null, motore: 'postgres', versione: '16.4', classe: 'db.t4g.large', vcpu: 2, memGb: 8,
    multiAz: false, replica: false, discoGb: 100, squadra: 'product', cpuP95: 41.0, memLiberaMin: 22.0, connessioniMax: 18, connessioniLimite: null,
    usdMese: 0.142 * ORE_MESE, proposta: null, tipoDisco: 'gp3', discoGbMese: 0.137,
  },
]

const ACCOUNTS = {
  prod: { label: 'Production', color: '#cf1322', region: 'eu-west-1', nonProd: false, avvisi: [], suEc2: 0 },
  staging: { label: 'Staging', color: '#1677ff', region: 'eu-west-1', nonProd: true, avvisi: [], suEc2: 0 },
}

export function efficienzaDemo(giorni = 30) {
  const fine = Math.floor(Date.UTC(2026, 9, 20, 12) / ORA) * ORA
  const servizi = FLOTTA.map((r) => servizio(r, giorni, fine))
  const out = {
    giorni,
    tagSquadra: TAG_SQUADRA,
    generato: new Date(fine).toISOString(),
    accounts: ACCOUNTS,
    servizi: [],
    database: DATABASE,
    settimane: {},
    leve: [],
    impegni: { prod: { quota: 0, coperta: 0, totale: 1610 }, staging: { quota: 0, coperta: 0, totale: 240 } },
    postgres: { configurati: ['main-db'] },
  }
  for (const key of Object.keys(ACCOUNTS)) {
    const mie = servizi.filter((s) => s.account === key)
    const settimana = settimanaAccount(mie)
    out.settimane[key] = settimana
    out.leve.push(
      ...leveAccount({ account: key, ambienteNonProd: ACCOUNTS[key].nonProd, servizi: mie, database: DATABASE.filter((d) => d.account === key), settimana }),
    )
  }
  out.leve = out.leve.filter((l) => l.usdMese > 0.5).sort((a, b) => b.usdMese - a.usdMese)
  out.servizi = servizi.map(({ orarie, listino, ...s }) => s)
  return out
}
