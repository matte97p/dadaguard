// Lo storico della flotta SENZA stato proprio: «com'è andata nelle ultime 24 ore» ricostruito da
// quello che AWS conserva già (storia degli allarmi CloudWatch, eventi dei servizi ECS, esiti delle
// build già letti per la pagina Deploy). Dadaguard non scrive niente da nessuna parte, quindi non ha
// un suo registro dei guasti: se lo tenesse, ogni riavvio del processo lo perderebbe e due istanze
// racconterebbero due storie diverse. AWS invece la storia la tiene già, e per tutti uguale.
//
// Qui c'è solo la parte PURA: entrano le righe già lette, escono secchi, KPI e cronologia. Le chiamate
// stanno in storicoAws.js, così la logica (che è quella che sbaglia in silenzio) si prova senza rete.
import { ambienteDi } from './rilasci.js'
import { stripOrgEnv } from './util/envToken.js'

export const SECCHIO_MS = 30 * 60_000
// Entro quanto un guasto si attribuisce a un deploy dello stesso servizio. Mezz'ora è il tempo in cui
// un rilascio di solito si rivela rotto (rollout, primo traffico, primo cron); oltre, la coincidenza
// diventa più probabile della causa, e una correlazione falsa manda a fare rollback del codice giusto.
export const CORRELAZIONE_MS = 30 * 60_000

const ORDINE = { ok: 0, warn: 1, crit: 2 }
export const peggiore = (a = 'ok', b = 'ok') => (ORDINE[b] > ORDINE[a] ? b : a)

const ms = (v) => (v == null ? NaN : new Date(v).getTime())

// L'ambiente di una chiave d'account, con Cloudflare come pseudo-account: non ha «produzione» nel nome,
// ma è un posto dove si rilascia e si rompe, e lasciarlo fuori darebbe una riga verde per omissione.
// I conti senza ambiente (payer, security) restano fuori come in rilasci.js. Pura.
export function ambienteDiConto(chiave, conto = {}) {
  if (conto?.provider === 'cloudflare' || chiave === 'cloudflare') return 'cloudflare'
  return ambienteDi(chiave)
}

// Il servizio di un allarme, dalle sue DIMENSIONI: è l'unico legame che AWS dà fra un allarme e una
// risorsa, ed è lo stesso che usa checks/alarms.js. Si toglie `<org>-<env>-` come per le build, così
// l'allarme di `acme-production-backend` e il deploy di `backend` parlano dello stesso servizio. Un
// allarme senza dimensioni riconoscibili non ha servizio: meglio nessuna correlazione che una inventata.
const DIMENSIONI_SERVIZIO = ['ServiceName', 'FunctionName', 'DBClusterIdentifier', 'DBInstanceIdentifier', 'CacheClusterId']
export function servizioDiAllarme(meta = {}) {
  const dims = meta?.Dimensions ?? meta?.dimensions ?? []
  for (const nome of DIMENSIONI_SERVIZIO) {
    const d = dims.find((x) => x.Name === nome)
    if (d?.Value) return stripOrgEnv(d.Value) || d.Value
  }
  return null
}

const statoDi = (dati, lato) => {
  try {
    return JSON.parse(dati || '{}')?.[lato]?.stateValue ?? null
  } catch {
    return null // HistoryData non JSON: si ignora, non si indovina
  }
}

// Le voci `StateUpdate` di DescribeAlarmHistory diventano INTERVALLI di guasto per allarme: da quando
// è entrato in ALARM a quando ne è uscito. Due casi ai bordi, entrambi da non perdere:
// - la prima voce della finestra è un'uscita da ALARM: il guasto era già in corso prima, quindi
//   l'intervallo parte dall'inizio della finestra (non è «mai successo»);
// - l'ultima voce è un'entrata in ALARM: il guasto è ancora in corso, `fine: null`.
// `inizioNoto: false` dice il primo caso, così la cronologia non lo racconta come «iniziato alle X». Pura.
export function intervalliAllarmi(voci = [], { da, meta = {} } = {}) {
  const perAllarme = new Map()
  for (const v of voci) {
    const nome = v.AlarmName
    if (!nome || (v.HistoryItemType && v.HistoryItemType !== 'StateUpdate')) continue
    if (!perAllarme.has(nome)) perAllarme.set(nome, [])
    perAllarme.get(nome).push(v)
  }
  const out = []
  for (const [nome, lista] of perAllarme) {
    lista.sort((a, b) => ms(a.Timestamp) - ms(b.Timestamp))
    const servizio = servizioDiAllarme(meta[nome])
    let aperto = null
    for (const [i, v] of lista.entries()) {
      const nuovo = statoDi(v.HistoryData, 'newState')
      const vecchio = statoDi(v.HistoryData, 'oldState')
      if (nuovo === 'ALARM' && !aperto) aperto = { inizio: ms(v.Timestamp), inizioNoto: true }
      else if (nuovo !== 'ALARM' && vecchio === 'ALARM') {
        const inizio = aperto ?? (i === 0 ? { inizio: ms(da), inizioNoto: false } : null)
        if (inizio) out.push({ allarme: nome, servizio, ...inizio, fine: ms(v.Timestamp) })
        aperto = null
      }
    }
    if (aperto) out.push({ allarme: nome, servizio, ...aperto, fine: null })
  }
  // Un allarme in ALARM da prima della finestra e mai uscito non ha voci nella storia: senza questo
  // giro la barra sarebbe verde proprio sul guasto piu' lungo. Lo stato attuale lo dice DescribeAlarms.
  for (const [nome, m] of Object.entries(meta ?? {})) {
    if (m?.StateValue === 'ALARM' && !perAllarme.has(nome)) {
      out.push({ allarme: nome, servizio: servizioDiAllarme(m), inizio: ms(da), inizioNoto: false, fine: null })
    }
  }
  return out.sort((a, b) => a.inizio - b.inizio)
}

// Gli eventi di servizio ECS che dicono un problema. ECS non ha un livello: scrive frasi, e quelle che
// contano hanno sempre le stesse parole («unable to place», «failed», «unhealthy»). Il «steady state»
// è il segnale normale e non deve colorare niente. Pura.
const ECS_PROBLEMA = /unable to|failed|unhealthy|stopped|error|insufficient/i
export function segnaliEcs(eventi = []) {
  return eventi
    .filter((e) => ECS_PROBLEMA.test(e.message ?? '') && !/steady state/i.test(e.message ?? ''))
    .map((e) => ({ ts: ms(e.ts), livello: 'warn', fonte: 'ecs', servizio: e.servizio ?? null, testo: e.message }))
}

// Una build fallita è un'ATTENZIONE, non un guasto: il servizio continua a girare la versione di prima.
// Contarla rossa direbbe «produzione giù» ogni volta che un test non passa. Stesso per un riavvio
// respinto. Pura.
export function segnaliBuild(builds = []) {
  return builds
    .filter((b) => ['FAILED', 'FAULT', 'TIMED_OUT'].includes(b.status))
    .map((b) => ({ ts: ms(b.startedAt), livello: 'warn', fonte: b.kind === 'restart' ? 'riavvio' : 'build', servizio: b.service ?? null }))
}

// I secchi: `ore * 2` intervalli da 30 minuti che finiscono ADESSO. Un secchio è `crit` se un guasto
// (intervallo d'allarme) lo tocca anche per un minuto, `warn` se ci cade un segnale puntuale, `ok`
// altrimenti. «Anche per un minuto» è voluto: la domanda è «è successo qualcosa in quella mezz'ora?»,
// e un guasto di cinque minuti che sparisce dal grafico è il guasto di cui nessuno saprà mai. Pura.
export function secchi({ intervalli = [], segnali = [], ora = Date.now(), ore = 24 } = {}) {
  const n = Math.max(1, Math.round(ore * 2))
  const fine = ms(ora)
  const inizio = fine - n * SECCHIO_MS
  return Array.from({ length: n }, (_, i) => {
    const da = inizio + i * SECCHIO_MS
    const a = da + SECCHIO_MS
    let livello = 'ok'
    const motivi = new Set()
    for (const g of intervalli) {
      const gFine = g.fine ?? fine
      if (g.inizio < a && gFine >= da) {
        livello = 'crit'
        motivi.add('allarme')
      }
    }
    for (const s of segnali) {
      if (s.ts >= da && s.ts < a) {
        livello = peggiore(livello, s.livello)
        motivi.add(s.fonte)
      }
    }
    return { da: new Date(da).toISOString(), livello, motivi: [...motivi] }
  })
}

// La disponibilità APPROSSIMATA: la quota di secchi senza guasti. Non è un SLA (non misura richieste
// riuscite, misura «nessun allarme acceso»), e per questo il payload lo dichiara accanto al numero.
// Una cifra decimale: di più sarebbe precisione finta su una grana di mezz'ora. Pura.
export function disponibilita(lista = []) {
  if (!lista.length) return null
  const rossi = lista.filter((s) => s.livello === 'crit').length
  return Math.round((1 - rossi / lista.length) * 1000) / 10
}

// Mezzanotte LOCALE del giorno di `ora`: «oggi» è quello di chi guarda la dashboard, non quello di UTC,
// che in Italia farebbe cominciare la giornata all'una o alle due di notte. Pura.
export function inizioGiorno(ora = Date.now()) {
  const d = new Date(ms(ora))
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Un confronto oggi/ieri con il suo delta. `delta` assoluto sempre; `pct` solo se ieri non è zero,
// perché «+∞%» non dice niente a nessuno. Pura.
export function confronto(oggi, ieri) {
  const ok = (v) => v != null && Number.isFinite(v)
  return {
    oggi: ok(oggi) ? oggi : null,
    ieri: ok(ieri) ? ieri : null,
    delta: ok(oggi) && ok(ieri) ? Math.round((oggi - ieri) * 1000) / 1000 : null,
    pct: ok(oggi) && ok(ieri) && ieri !== 0 ? Math.round(((oggi - ieri) / ieri) * 1000) / 10 : null,
  }
}

// Deploy riusciti e falliti oggi contro ieri. Si contano le BUILD finite: un riavvio non rilascia
// codice, e una build in corso non ha ancora un esito. Pura.
export function kpiDeploy(builds = [], ora = Date.now()) {
  const oggi0 = inizioGiorno(ora)
  const ieri0 = oggi0 - 24 * 3600_000
  const conta = (da, a, esito) =>
    builds.filter((b) => {
      if (b.kind === 'restart' || b.inProgress) return false
      const t = ms(b.startedAt)
      if (!(t >= da && t < a)) return false
      return esito === 'ok' ? b.status === 'SUCCEEDED' : ['FAILED', 'FAULT', 'TIMED_OUT'].includes(b.status)
    }).length
  return {
    riusciti: confronto(conta(oggi0, ms(ora) + 1, 'ok'), conta(ieri0, oggi0, 'ok')),
    falliti: confronto(conta(oggi0, ms(ora) + 1, 'ko'), conta(ieri0, oggi0, 'ko')),
  }
}

// La cronologia di oggi: deploy, riavvii, inizio dei guasti, in ordine di tempo. Ogni guasto che parte
// entro 30 minuti da un deploy DELLO STESSO servizio e dello stesso ambiente porta `dopoDeploy`, cioè
// «rotto N minuti dopo il deploy X». Si prende il deploy PIÙ VICINO prima del guasto: con due rilasci in
// mezz'ora il sospettato è l'ultimo, ed è quello da cui si parte per un rollback. Un guasto il cui
// inizio non si conosce (era già in corso a inizio finestra) non si correla: non sappiamo quando è
// cominciato, quindi non sappiamo cosa c'era prima. Pura.
export function cronologia({ eventi = [], ora = Date.now() } = {}) {
  const oggi0 = inizioGiorno(ora)
  // Solo i deploy RIUSCITI: una build fallita non ha cambiato cosa gira, quindi non può aver rotto niente.
  const deploy = eventi.filter((e) => e.tipo === 'deploy' && e.esito === 'ok')
  const out = []
  for (const e of eventi) {
    if (!(e.ts >= oggi0 && e.ts <= ms(ora))) continue
    if (e.tipo !== 'guasto') {
      out.push(e)
      continue
    }
    const sospetto = e.inizioNoto === false || !e.servizio
      ? null
      : deploy
          .filter((d) => d.servizio === e.servizio && d.ambiente === e.ambiente && d.ts <= e.ts && e.ts - d.ts <= CORRELAZIONE_MS)
          .sort((a, b) => b.ts - a.ts)[0]
    out.push(sospetto ? { ...e, dopoDeploy: { id: sospetto.id, commit: sospetto.commit ?? null, minuti: Math.round((e.ts - sospetto.ts) / 60_000) } } : e)
  }
  return out.sort((a, b) => a.ts - b.ts).map((e) => ({ ...e, quando: new Date(e.ts).toISOString() }))
}

// Build e riavvii di un ambiente diventano eventi della cronologia. Solo i riavvii riusciti contano
// come «riavvio»: uno respinto non ha toccato il servizio, e sta già fra le attenzioni dei secchi. Pura.
export function eventiDaBuild(builds = [], ambiente) {
  return builds
    .filter((b) => !b.inProgress && b.startedAt)
    .filter((b) => b.kind !== 'restart' || b.status === 'SUCCEEDED')
    .map((b) => ({
      tipo: b.kind === 'restart' ? 'riavvio' : 'deploy',
      ts: ms(b.startedAt),
      ambiente,
      servizio: b.service ?? null,
      id: b.id ?? null,
      commit: b.commit ?? null,
      esito: b.status === 'SUCCEEDED' ? 'ok' : 'ko',
      ...(b.kind === 'restart' ? { chi: b.forcedBy ?? null } : {}),
    }))
}

// Gli intervalli d'allarme diventano l'evento «inizio guasto». Pura.
export const eventiDaGuasti = (intervalli = [], ambiente) =>
  intervalli.map((g) => ({
    tipo: 'guasto',
    ts: g.inizio,
    ambiente,
    servizio: g.servizio,
    allarme: g.allarme,
    inizioNoto: g.inizioNoto,
    finito: g.fine != null,
  }))

// Cosa dice il payload di sé: è un'approssimazione, ed elenca le fonti. Chi legge «99,0%» deve poter
// sapere che è «nessun allarme acceso nel 99% delle mezz'ore», non le richieste riuscite.
export const NOTA = {
  approssimato: true,
  fonti: ['cloudwatch:DescribeAlarmHistory', 'ecs:DescribeServices (eventi)', 'codebuild (deploy già letti)', 'cloudtrail (riavvii già letti)', 'cloudflare (deploy già letti)'],
  secchioMinuti: SECCHIO_MS / 60_000,
  correlazioneMinuti: CORRELAZIONE_MS / 60_000,
}

// Il pezzo che unisce tutto per un ambiente, dalle letture già fatte. Pura.
export function storicoAmbiente({ ambiente, builds = [], voci = [], meta = {}, ecs = [], ora = Date.now(), ore = 24 }) {
  const da = ms(ora) - ore * 3600_000
  const intervalli = intervalliAllarmi(voci, { da, meta })
  const segnali = [...segnaliBuild(builds.filter((b) => ms(b.startedAt) >= da)), ...segnaliEcs(ecs)]
  const lista = secchi({ intervalli, segnali, ora, ore })
  return {
    secchi: lista,
    livello: lista.reduce((acc, s) => peggiore(acc, s.livello), 'ok'),
    disponibilita: disponibilita(lista),
    eventi: [...eventiDaBuild(builds, ambiente), ...eventiDaGuasti(intervalli, ambiente)],
  }
}

// Il tasso d'errore in percentuale, su richieste o invocazioni. Null se non c'è traffico: «0%» su zero
// richieste direbbe «tutto bene» dove non si è misurato niente. Pura.
export function tassoErrore(errori, totale) {
  if (errori == null || !totale) return null
  return Math.round((errori / totale) * 10000) / 100
}

// Le metriche oggi/ieri (Lambda e ALB) come confronti. Pura.
export function kpiMetriche(m) {
  if (!m) return null
  const { oggi, ieri } = m
  return {
    lambdaErrorePct: confronto(tassoErrore(oggi?.lambda?.errori, oggi?.lambda?.invocazioni), tassoErrore(ieri?.lambda?.errori, ieri?.lambda?.invocazioni)),
    lambdaP95ms: confronto(oggi?.lambda?.p95ms ?? null, ieri?.lambda?.p95ms ?? null),
    albErrorePct: confronto(tassoErrore(oggi?.alb?.errori, oggi?.alb?.richieste), tassoErrore(ieri?.alb?.errori, ieri?.alb?.richieste)),
    albP95ms: confronto(oggi?.alb?.p95ms ?? null, ieri?.alb?.p95ms ?? null),
  }
}

// Due conti per lo stesso ambiente (raro) si fondono: ogni secchio prende il peggiore dei due. Pura.
function fondi(a, b) {
  const secchiF = a.secchi.map((s, i) => {
    const t = b.secchi[i]
    return ORDINE[t.livello] > ORDINE[s.livello] ? { ...s, livello: t.livello, motivi: [...new Set([...s.motivi, ...t.motivi])] } : s
  })
  return {
    ...a,
    secchi: secchiF,
    livello: peggiore(a.livello, b.livello),
    disponibilita: disponibilita(secchiF),
    eventi: [...a.eventi, ...b.eventi],
    errori: [...a.errori, ...b.errori],
    troncato: a.troncato || b.troncato,
    conti: [...a.conti, ...b.conti],
  }
}

// Il payload di /api/history dalle letture per conto. Puro: lo usano sia il server sia la demo, così
// la demo non è una seconda implementazione che un giorno racconta un'altra storia.
export function componiStorico({ perConto = {}, ora = Date.now(), ore = 24 } = {}) {
  const ambienti = {}
  const eventi = []
  const tutteBuild = []
  const buildPerAmbiente = {}
  for (const [chiave, c] of Object.entries(perConto)) {
    const amb = ambienteDiConto(chiave, c)
    if (!amb) continue
    const builds = c.builds ?? []
    tutteBuild.push(...builds)
    const s = storicoAmbiente({ ambiente: amb, builds, voci: c.voci, meta: c.meta, ecs: c.ecs, ora, ore })
    const blocco = { ...s, kpi: { deploy: kpiDeploy(builds, ora), metriche: kpiMetriche(c.metriche) }, troncato: !!c.troncato, errori: c.errori ?? [], conti: [chiave] }
    if (ambienti[amb]) {
      // Fondendo due conti i KPI dei deploy si ricontano su TUTTE le build dell'ambiente: tenere
      // quelli del primo conto perderebbe in silenzio i rilasci del secondo.
      const tutte = [...buildPerAmbiente[amb], ...builds]
      buildPerAmbiente[amb] = tutte
      ambienti[amb] = fondi(ambienti[amb], blocco)
      ambienti[amb].kpi = { ...ambienti[amb].kpi, deploy: kpiDeploy(tutte, ora) }
    } else {
      buildPerAmbiente[amb] = builds
      ambienti[amb] = blocco
    }
  }
  for (const b of Object.values(ambienti)) {
    eventi.push(...b.eventi)
    delete b.eventi
  }
  return {
    generatoIl: new Date(ms(ora)).toISOString(),
    ore,
    nota: { ...NOTA, p95: 'Lambda a livello di account; ALB il peggiore fra i bilanciatori (i percentili non si sommano)' },
    ambienti,
    kpi: { deploy: kpiDeploy(tutteBuild, ora) },
    cronologia: cronologia({ eventi, ora }),
  }
}
