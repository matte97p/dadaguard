import { nodeIdOf } from '../shared/nodeId.js'
import { familyPrefixes, displayName } from './serviceName.js'
import { livelli, colonne, altezzaBox, altezzaCard } from './topoLayout.js'

// COME SI COSTRUISCE LA MAPPA DELL'ARCHITETTURA.
//
// Riscritto dopo aver contato: il grafo di dipendenze che questa pagina disegnava era per l'84% un
// artefatto (87 archi su 104 nascevano dal nome del cluster usato come identificativo di ogni suo
// membro, corretto in server/topology/deduce.js). Lucidare il layout di quel grafo era lucidare una
// cosa falsa, e nessun layout salva un disegno in cui metà delle frecce non esiste.
//
// La tesi nuova è quella del C4: UN DIAGRAMMA = UN LIVELLO. Al primo livello non ci sono risorse, ci
// sono GRUPPI — chi entra, chi serve, dove stanno i dati, cosa gira a orario — e gli archi fra gruppi
// sono fusi in uno solo per coppia. Le risorse si vedono scendendo dentro un gruppo. Un ambiente vero
// passa così da 30-38 card a 6-8 box, che è ciò che rende la pagina leggibile: non un layout migliore.
//
// Due regole che valgono più delle altre, e che i test difendono:
//  · PARTIZIONE TOTALE. Ogni servizio finisce in esattamente un gruppo, catch-all compreso. Una
//    whitelist chiusa farebbe sparire dalla pagina i tipi non previsti — e la modalità demo, che è
//    l'immagine pubblica del progetto, ha dodici tipi diversi.
//  · L'ASSENZA NON È UN ALLARME. Il roll-up conta i PROBLEMI (giù, degradati), non «X su N attivi»:
//    un modello Bedrock senza invocazioni nella finestra è `idle`, e chiamarlo «5 su 9 attivi» in
//    rosso trasforma «nessuno l'ha chiamato» in «è rotto».

// Chiave di un nodo: la STESSA del server, presa dal modulo condiviso (shared/nodeId.js). Erano due
// omonime con firme diverse, e due chiavi che divergono fondono o sdoppiano i nodi in silenzio.
export const topologyNodeId = nodeIdOf
// La chiave con cui il grafo nomina un nodo. Per un servizio è `account::nome`; un sistema esterno ha
// già un id suo (`ext:host:esempio.com`), perché non sta in nessun account.
export const chiaveDi = (s) => (s?.esterno ? s.esterno.id : topologyNodeId(s))
export const acctLabel = (s) => (typeof s.account === 'string' ? s.account : s.account?.label) ?? null
export const acctKey = (s) => (typeof s.account === 'string' ? s.account : s.account?.key) ?? '__none__'

export const STATUS_COLOR = {
  up: '#52c41a',
  degraded: '#faad14',
  down: '#ff4d4f',
  idle: '#8c8c8c',
  disabled: '#8c8c8c',
  unknown: '#8c8c8c',
}

// Provenienza dell'arco → quanto ci si può credere. `lb` è un puntatore vero (un target group registra
// quel servizio); le altre sono deduzioni da nomi che compaiono in una configurazione o in una policy.
// La differenza si DISEGNA (piena vs tratteggiata) invece di essere spiegata in una legenda.
export const VIA = {
  lb: { color: '#fa8c16', forte: true },
  // L'indirizzo di un load balancer citato in una configurazione, risolto sull'ascoltatore di quella
  // porta: chi chiama lo dice, chi risponde lo dice AWS. È un puntatore, non una somiglianza di nomi.
  route: { color: '#fa8c16', forte: true },
  net: { color: '#13c2c2', forte: true },
  event: { color: '#7c3aed', forte: true },
  flow: { color: '#eb2f96', forte: true },
  declared: { color: '#8c8c8c', forte: true },
  env: { color: '#1677ff', forte: false },
  iam: { color: '#08979c', forte: false },
}
export const isViaForte = (vias = []) => vias.some((v) => VIA[v]?.forte)

// I GRUPPI del primo livello, in ordine di lettura: come entra una richiesta, chi la serve, dove stanno
// i dati, cosa gira da solo. L'ultimo è il catch-all e non ha condizione: è lui a garantire che nessun
// servizio possa sparire dalla pagina.
export const GRUPPI = [
  { key: 'ingress', tipi: ['alb', 'cloudfront', 'apigateway', 'cloudflare-worker'] },
  { key: 'app', tipi: ['ecs', 'ec2'] },
  { key: 'data', tipi: ['rds', 'elasticache', 'dynamodb', 's3', 'kinesis', 'sqs', 'opensearch'] },
  // Una state machine sta con ciò che gira da solo, non con i dati: orchestra dei passi, non li
  // conserva. Sotto «dove stanno i dati» era una risposta sbagliata alla domanda del gruppo.
  { key: 'sched', match: (s) => s.type === 'ecs-scheduled' || s.type === 'sfn' || (s.type === 'lambda' && haSchedule(s)) },
  { key: 'event', tipi: ['lambda'] },
  { key: 'models', tipi: ['bedrock'] },
  { key: 'ext', tipi: ['esterno'] },
  { key: 'other', catchAll: true },
]

// Un cron si riconosce dal fatto che il check runtime ha uno schedule: il TIPO non basta, perché una
// lambda a orario e una lambda a evento sono lo stesso tipo AWS. È lo stesso segnale che il dead-man
// switch usa per decidere se un silenzio è un guasto.
export function haSchedule(s) {
  const r = s?.checks?.runtime
  return Boolean(r?.schedule || r?.scheduleExpr || r?.nextRunAt)
}

// A quale gruppo appartiene un servizio. Pura, e totale per costruzione.
export function groupOf(service) {
  for (const g of GRUPPI) {
    if (g.catchAll) return g.key
    if (g.match?.(service)) return g.key
    if (g.tipi?.includes(service?.type)) return g.key
  }
  return 'other'
}

// Il RIASSUNTO di un gruppo, che è la sua unica riga di testo oltre al titolo. Conta i problemi, non
// gli attivi (vedi la regola in testa al file), e dice i task solo dove i numeri esistono davvero
// (`runningCount`/`desiredCount` stanno solo sui servizi ECS). Pura/testabile.
export function rollup(servizi = [], now = Date.now(), rischi = new Map()) {
  const problemi = servizi.filter((s) => s.overall === 'down' || s.overall === 'degraded')
  const conTask = servizi.filter((s) => s.checks?.runtime?.desiredCount != null)
  const attivi = conTask.reduce((n, s) => n + (s.checks.runtime.runningCount ?? 0), 0)
  const voluti = conTask.reduce((n, s) => n + s.checks.runtime.desiredCount, 0)
  const prossimi = servizi.map((s) => s.checks?.runtime?.nextRunAt).filter((x) => Number.isFinite(x) && x > now)
  // A RISCHIO: membri sani che dipendono da qualcosa in difficoltà (vedi web/topoImpact.js). È la cosa
  // che la home NON sa dire: lei elenca chi è rotto, questa riga dice chi altro ne sta soffrendo.
  const aRischio = servizi.filter((s) => rischi.has(chiaveDi(s)))
  return {
    membri: servizi.length,
    problemi: problemi.length,
    // Nome del primo servizio in difficoltà: su un box con dodici membri, «1 problema» senza il nome
    // costringe ad aprire per sapere chi.
    primoProblema: problemi[0]?.name ?? null,
    task: conTask.length ? { attivi, voluti, male: attivi < voluti } : null,
    prossimo: prossimi.length ? Math.min(...prossimi) : null,
    // `idle` e `disabled` si CONTANO ma non colorano: sono un'assenza di traffico, non un guasto.
    fermi: servizi.filter((s) => s.overall === 'idle' || s.overall === 'disabled').length,
    // Tutto sconosciuto = non l'abbiamo guardato (i sistemi esterni). «Nessun problema» lì sarebbe
    // affermare il contrario di quello che sappiamo, cioè niente.
    ignoto: servizi.length > 0 && servizi.every((s) => s.overall === 'unknown'),
    // Ma «non l'abbiamo guardato» e «lo stiamo guardando adesso» sono due cose diverse, e distinguerle
    // serve solo se i membri sono ROBA NOSTRA: di un sistema di terzi non leggeremo lo stato nemmeno
    // dopo, quindi lì la frase resta quella.
    nostri: servizi.some((s) => !s.esterno),
    aRischio: aRischio.length,
    // Il NOME di ciò che li mette a rischio: «3 a rischio» senza dire da cosa costringe a cercare a
    // mano proprio la cosa che il disegno dovrebbe far vedere.
    causa: aRischio.length ? rischi.get(chiaveDi(aRischio[0]))[0] : null,
  }
}

// La TESTA COMUNE di un elenco di nomi, tagliata al confine di un trattino. Serve a mostrarla una volta
// sola in cima al box invece che su ogni riga: compattarla in grigio (come fanno le card) NON fa
// risparmiare un pixel, e in un box da 224px i nomi dei cron finivano tagliati a metà — cioè proprio
// sulla parte che li distingue. Si applica solo se toglie almeno sei caratteri a TUTTI: sotto quella
// soglia si guadagna niente e si perde il nome intero. Pura/testabile.
export function testaComune(nomi = [], minimo = 6) {
  if (nomi.length < 2) return null
  const pezzi = nomi[0].split('-')
  let testa = ''
  for (let i = 0; i < pezzi.length - 1; i++) {
    const cand = `${testa}${pezzi[i]}-`
    if (!nomi.every((n) => n.startsWith(cand) && n.length > cand.length)) break
    testa = cand
  }
  return testa.length >= minimo ? testa : null
}

// Nomi da mostrare in un box: senza la testa comune, e disambiguati se due coincidono (due modelli
// Bedrock diversi possono avere lo stesso nome parlante, e vederlo due volte sembra un errore). Pura.
export function nomiDaMostrare(servizi, nomeDi, quanti = 4) {
  const completi = servizi.map(nomeDi)
  const testa = testaComune(completi)
  const visti = new Map()
  const nomi = servizi.slice(0, quanti).map((s, i) => {
    let n = testa ? completi[i].slice(testa.length) : completi[i]
    if (visti.has(n)) {
      // Due nomi uguali: si aggiunge ciò che li distingue davvero (per i modelli è l'area di inferenza,
      // che è anche l'informazione che conta: `global.` può uscire dall'Unione Europea).
      const scope = String(s.name).split('.')[0]
      if (scope && scope !== s.name) n = `${n} · ${scope}`
    }
    visti.set(n, true)
    return n
  })
  return { testa, nomi }
}

// Toglie la testa condivisa da un nome, quando c'è. Pura.
export const scorcia = (nome, testa) => (testa && String(nome).startsWith(testa) ? String(nome).slice(testa.length) : nome)

// Ordine di importanza dentro a un gruppo: chi è giù, poi chi è degradato, poi il resto. Pura.
export const peso = (s) => (s.overall === 'down' ? 0 : s.overall === 'degraded' ? 1 : s.overall === 'idle' || s.overall === 'disabled' ? 3 : 2)

// Colore dell'accento di un gruppo: solo i guasti lo colorano.
export const coloreGruppo = (r) =>
  r.problemi > 0 ? STATUS_COLOR.down : r.aRischio > 0 ? STATUS_COLOR.degraded : r.ignoto ? STATUS_COLOR.unknown : STATUS_COLOR.up

// Archi FUSI fra gruppi: una sola freccia per coppia ordinata, con dentro il conto e le provenienze.
// È il boxing di Kiali nella sua forma forte — il box assorbe gli archi — ed è ciò che fa scendere il
// disegno da decine di frecce a una manciata. Pura/testabile.
export function fondiArchi(edges = [], gruppoDi) {
  const per = new Map()
  for (const e of edges) {
    const a = gruppoDi(e.source)
    const b = gruppoDi(e.target)
    if (!a || !b || a === b) continue // gli archi interni al gruppo si vedono scendendo dentro
    const k = `${a}->${b}`
    if (!per.has(k)) per.set(k, { source: a, target: b, n: 0, vias: new Set(), coppie: [] })
    const v = per.get(k)
    v.n += 1
    for (const via of e.vias ?? []) v.vias.add(via)
    v.coppie.push([e.source, e.target])
  }
  return [...per.values()].map((v) => ({ ...v, vias: [...v.vias], forte: isViaForte([...v.vias]) }))
}

// Da che LATO esce e da che lato entra un arco, date le due posizioni. È la differenza fra un disegno
// che si legge e uno in cui gli archi girano intorno alle card: due riquadri nella stessa colonna si
// collegano sotto/sopra, non destra/sinistra. Pura/testabile.
export function maniglie(a, b) {
  if (!a || !b) return { sourceHandle: 'r-s', targetHandle: 'l-t' }
  const dx = b.x - a.x
  if (Math.abs(dx) > 8)
    return dx > 0 ? { sourceHandle: 'r-s', targetHandle: 'l-t' } : { sourceHandle: 'l-s', targetHandle: 'r-t' }
  return b.y >= a.y ? { sourceHandle: 'b-s', targetHandle: 't-t' } : { sourceHandle: 't-s', targetHandle: 'b-t' }
}

// Due archi opposti fra gli stessi due nodi diventano UN arco con la punta alle due estremità. Disegnati
// separati si sovrapponevano quasi del tutto, e il risultato era una linea doppia che non diceva niente:
// «si chiamano a vicenda» è un fatto solo, e come tale va disegnato. Pura/testabile.
export function unisciReciproci(archi = []) {
  const per = new Map(archi.map((a) => [`${a.source}>${a.target}`, a]))
  const out = []
  const fatti = new Set()
  for (const a of archi) {
    const chiave = `${a.source}>${a.target}`
    if (fatti.has(chiave)) continue
    const opposto = per.get(`${a.target}>${a.source}`)
    fatti.add(chiave)
    if (!opposto) {
      out.push(a)
      continue
    }
    fatti.add(`${a.target}>${a.source}`)
    const vias = [...new Set([...(a.data?.vias ?? []), ...(opposto.data?.vias ?? [])])]
    const forte = isViaForte(vias)
    const n = (Number(a.label) || 0) + (Number(opposto.label) || 0)
    out.push({
      ...a,
      data: { ...a.data, vias, forte, doppio: true },
      label: n ? String(n) : a.label,
      style: { ...a.style, strokeDasharray: forte ? undefined : '6 5', stroke: forte ? '#fa8c16' : '#8c8c8c' },
      markerStart: { type: 'arrowclosed', width: 12, height: 12, color: forte ? '#fa8c16' : '#8c8c8c' },
      markerEnd: { type: 'arrowclosed', width: 12, height: 12, color: forte ? '#fa8c16' : '#8c8c8c' },
    })
  }
  return out
}

// Quanto manca, in parole: «fra 12m», «fra 3h». Gemella di fmtSchedule/fmtAgo in web/format.js, che
// però parlano del passato. Pura.
export function fraTempo(ms, t = (k) => k) {
  const min = Math.max(1, Math.round(ms / 60000))
  if (min < 60) return `${min}${t('time.unit.m')}`
  if (min < 1440) return `${Math.round(min / 60)}${t('time.unit.h')}`
  return `${Math.round(min / 1440)}${t('time.unit.d')}`
}

// Larghezza dei riquadri: 224 + 44 di stacco fa 1028px su tre colonne, che ci sta in una tela da mille.
// Con 250 + 70 la tela era 1210 e `fitView` scendeva a zoom 0,75, cioè testo a dieci pixel e mezzo.
// L'ALTEZZA non è più una costante: la calcola il contenuto (vedi web/topoLayout.js). Con 138 fissi un
// gruppo con quattro nomi e due righe di riassunto scriveva le ultime righe FUORI dal bordo.
const W = 224
const GAP_X = 44
const GAP_Y = 28

// I nodi che NON sono servizi nostri ma stanno nel grafo: un Supabase, un endpoint di ricerca, una coda
// che nessuno ha dichiarato. Sono citati nella configurazione di chi li usa, e senza di loro la mappa
// taceva su metà dei dati dello stack, «dove finiscono le scritture» compreso. Entrano solo se un arco li
// lega a QUESTO ambiente: sennò in staging comparirebbero anche quelli nominati soltanto dalla produzione.
// Il gruppo lo decide il loro TIPO, come per i servizi: una coda SQS non dichiarata è un dato, non un
// «sistema esterno», e metterla fra i terzi la nasconderebbe dove nessuno la cerca.
export function esterniDi(services = [], topo = {}) {
  const nostre = new Set(services.map((x) => topologyNodeId(x)))
  const usati = new Set()
  for (const e of topo.edges ?? []) {
    if (nostre.has(e.source) && !nostre.has(e.target)) usati.add(e.target)
    if (nostre.has(e.target) && !nostre.has(e.source)) usati.add(e.source)
  }
  return (topo.extraNodes ?? [])
    .filter((n) => usati.has(n.id))
    // `overall: 'unknown'` e non `up`: di un sistema di terzi non sappiamo lo stato, e dire «nessun
    // problema» sarebbe affermare il contrario di quello che sappiamo, cioè niente.
    .map((n) => ({ name: n.label ?? n.id, type: n.type ?? 'esterno', account: null, overall: 'unknown', esterno: n }))
}

export function buildMap(services = [], topo = {}, t = (k) => k, { now = Date.now(), rischi = new Map(), usi = new Map(), statoPronto = true } = {}) {
  // La testa condivisa dei nomi si conta su TUTTO l'ambiente: dev'essere la stessa in ogni box, sennò
  // l'occhio la rilegge ogni volta invece di saltarla.
  // `displayName` e non `name`: un modello Bedrock si chiama
  // `eu.anthropic.claude-haiku-4-5-20251001-v1:0`, che in un box da 224px è una riga di rumore. La
  // funzione che lo rende leggibile («Claude Haiku 4.5») esiste già ed è la stessa delle card.
  const nomeDi = (x) => displayName(x)
  const prefissi = familyPrefixes(services.filter((s) => s.type !== 'bedrock').map((s) => s.name))
  const perGruppo = new Map(GRUPPI.map((g) => [g.key, []]))
  for (const s of [...services, ...esterniDi(services, topo)]) perGruppo.get(groupOf(s)).push(s)

  const gruppoDiChiave = new Map()
  for (const [key, lista] of perGruppo) for (const s of lista) gruppoDiChiave.set(chiaveDi(s), key)

  const visibili = GRUPPI.map((g) => g.key).filter((k) => (perGruppo.get(k) ?? []).length > 0)
  const fusi = fondiArchi(topo.edges ?? [], (id) => gruppoDiChiave.get(id) ?? null).filter(
    (a) => visibili.includes(a.source) && visibili.includes(a.target),
  )

  // LE COLONNE VENGONO DAGLI ARCHI, non da un elenco scritto qui: il livello è la distanza dal perimetro
  // calcolata sul grafo delle RISORSE (vedi web/topoLayout.js), e il gruppo prende il livello del suo
  // membro più a monte. Sui gruppi fusi non funziona: un solo arco strano (una lambda che cita
  // l'indirizzo di un load balancer interno) trascinerebbe tutto il gruppo «Ingresso» dietro gli eventi,
  // mentre i load balancer esposti che ci stanno dentro sono il perimetro. Il minimo è robusto a
  // quell'arco e resta una lettura dei dati, non una convenzione.
  const livelloNodo = livelli(
    [...gruppoDiChiave.keys()],
    (topo.edges ?? []).filter((e) => gruppoDiChiave.has(e.source) && gruppoDiChiave.has(e.target)),
  )
  const livelloDi = new Map(
    visibili.map((key) => [key, Math.min(...perGruppo.get(key).map((s) => livelloNodo.get(chiaveDi(s)) ?? 0))]),
  )

  const elementi = []
  const dati = new Map()
  for (const key of visibili) {
    const lista = perGruppo.get(key)
    const r = rollup(lista, now, rischi)
    // Ordine dentro al box: prima i guasti, POI i più usati. Su un gruppo di dati o di sistemi di
    // terzi i guasti sono rari e l'ordine alfabetico li mette in fila come se contassero uguale: il
    // Redis da cui dipendono cinque servizi e un bucket che nessuno cita non sono la stessa cosa.
    const nomiBox = nomiDaMostrare(
      [...lista].sort(
        (a, b) => peso(a) - peso(b) || (usi.get(chiaveDi(b)) ?? 0) - (usi.get(chiaveDi(a)) ?? 0) || nomeDi(a).localeCompare(nomeDi(b)),
      ),
      nomeDi,
    )
    const frasi = {
      // Anche qui la testa condivisa si toglie: scritta per intero, la riga del problema esce dal
      // box e taglia via il nome del servizio rotto, che è l'unica cosa che si voleva leggere.
      problemi: r.primoProblema
        ? `${t('topo.g.problems', { n: r.problemi })}: ${scorcia(r.primoProblema, nomiBox.testa)}`
        : t('topo.g.problems', { n: r.problemi }),
      // Tre frasi, non due: «nessun problema» quando lo stato c'è, «stato in arrivo» mentre i check sono
      // in volo, «stato non letto» per ciò che non guardiamo affatto. Con una frase sola per gli ultimi
      // due casi, all'apertura della pagina TUTTI i gruppi dicevano di non essere guardati, che è falso:
      // erano in lettura, e la differenza è fra un difetto e un'attesa.
      nessunProblema: !r.ignoto
        ? t('topo.g.noProblems')
        : !statoPronto && r.nostri
          ? t('topo.g.stateComing')
          : t('topo.g.unknownState'),
      // «2 a rischio: dipende da backend»: è la riga per cui vale la pena avere un disegno invece
      // di un elenco, perché la dipendenza che la genera non si vede da nessun'altra parte.
      rischio: r.aRischio ? `${t('topo.g.risk', { n: r.aRischio })}: ${scorcia(r.causa, nomiBox.testa)}` : '',
      task: t('topo.g.task'),
      prossimo: r.prossimo ? t('topo.g.next', { in: fraTempo(r.prossimo - now, t) }) : '',
      fermi: t('topo.g.idle', { n: r.fermi }),
    }
    // Quante righe di riassunto verranno scritte davvero: è l'altezza del riquadro. La riga dei fermi
    // cede il posto a quella del rischio (lo fa anche il componente): sono le due meno urgenti.
    const righeBody = 1 + (frasi.rischio ? 1 : 0) + (r.task ? 1 : 0) + (frasi.prossimo ? 1 : 0) + (r.fermi > 0 && !frasi.rischio ? 1 : 0)
    const h = altezzaBox({ nomi: nomiBox.nomi.length, testa: Boolean(nomiBox.testa), altri: Math.max(0, lista.length - 4), righeBody })
    elementi.push({ id: `g:${key}`, livello: livelloDi.get(key) ?? 0, w: W, h })
    dati.set(key, { r, nomiBox, frasi, lista, h })
  }

  const pos = colonne(elementi, { gapX: GAP_X, gapY: GAP_Y })
  const nodes = elementi.map((el) => {
    const key = el.id.slice(2)
    const { r, nomiBox, frasi, lista } = dati.get(key)
    return {
      id: el.id,
      type: 'gruppo',
      position: pos.get(el.id),
      // La geometria la dichiara il grafo, non il CSS: ReactFlow misura i nodi nel browser, e se la
      // misura vera non coincide con quella usata per posizionarli gli archi si attaccano di traverso.
      style: { width: el.w, height: el.h },
      data: {
        key,
        titolo: t(`topo.g.${key}`),
        rollup: r,
        colore: coloreGruppo(r),
        membri: lista,
        prefissi,
        ...nomiBox,
        altri: Math.max(0, lista.length - 4),
        frasi,
      },
    }
  })

  const archi = unisciReciproci(fusi.map((a) => ({
    id: `g:${a.source}->g:${a.target}`,
    source: `g:${a.source}`,
    target: `g:${a.target}`,
    ...maniglie(pos.get(`g:${a.source}`), pos.get(`g:${a.target}`)),
    type: 'default',
    label: String(a.n),
    data: { vias: a.vias, forte: a.forte, coppie: a.coppie },
    // Piena = c'è un puntatore vero (un target group registra quel servizio, o l'indirizzo del load
    // balancer sta nella configurazione di chi chiama). Tratteggiata = dedotta da un nome trovato in una
    // configurazione o in una policy: vera, ma non è un flusso.
    style: { strokeDasharray: a.forte ? undefined : '6 5', stroke: a.forte ? '#fa8c16' : '#8c8c8c' },
    markerEnd: { type: 'arrowclosed', width: 14, height: 14, color: a.forte ? '#fa8c16' : '#8c8c8c' },
  })))

  return { nodes, edges: archi, perGruppo, vuoto: nodes.length === 0 }
}

// LIVELLO 2: dentro un gruppo. Le risorse in griglia, e ai bordi gli STUB dei vicini — senza, scendendo
// si perde di vista con chi parla il gruppo, che è metà del motivo per cui ci si è scesi.
const WR = 208

export function buildGroup(groupKey, services = [], topo = {}, t = (k) => k, { now = Date.now(), rischi = new Map(), usi = new Map() } = {}) {
  // Gli esterni entrano fra i membri come i servizi: sennò scendendo in «Applicazioni» le frecce verso
  // di loro sparivano in silenzio, perché il vicino non apparteneva a nessun gruppo.
  const tutti = [...services, ...esterniDi(services, topo)]
  const dentro = tutti.filter((s) => groupOf(s) === groupKey)
  const chiaviDentro = new Set(dentro.map((s) => chiaveDi(s)))
  const nomeDi = new Map((topo.nodes ?? []).map((n) => [n.id, n.name]))
  const gruppoDi = new Map(tutti.map((s) => [chiaveDi(s), groupOf(s)]))

  // Il livello si calcola sul grafo INTERO, non sul sottografo del gruppo: dentro «Applicazioni» le
  // relazioni fra i membri passano da un load balancer interno, che sta in un altro gruppo. Guardando
  // solo gli archi interni tutti risultavano allo stesso livello, e si finiva in una griglia alfabetica
  // dove le frecce verso i vicini passavano in mezzo alle card, sembrando relazioni fra loro.
  const livelloGlobale = livelli(
    tutti.map((s) => chiaveDi(s)),
    topo.edges ?? [],
  )
  // Livelli COMPATTATI: fra i membri del gruppo possono esserci buchi (livello 1 e 4 e nient'altro), e
  // una colonna vuota in mezzo si legge come «qui manca qualcosa».
  const presenti = [...new Set(dentro.map((s) => livelloGlobale.get(chiaveDi(s)) ?? 0))].sort((a, b) => a - b)
  const colonnaDi = (s) => presenti.indexOf(livelloGlobale.get(chiaveDi(s)) ?? 0)

  const ordinati = [...dentro].sort(
    (a, b) =>
      colonnaDi(a) - colonnaDi(b) ||
      peso(a) - peso(b) ||
      (usi.get(chiaveDi(b)) ?? 0) - (usi.get(chiaveDi(a)) ?? 0) ||
      a.name.localeCompare(b.name),
  )

  // Vicini: chi parla con qualcuno di dentro, raggruppato per gruppo di appartenenza. Uno stub per
  // gruppo, non uno per risorsa: sennò il livello 2 ridiventa il grafo intero.
  const stubIn = new Map()
  const stubOut = new Map()
  for (const e of topo.edges ?? []) {
    const dentroS = chiaviDentro.has(e.source)
    const dentroT = chiaviDentro.has(e.target)
    if (dentroS === dentroT) continue
    const altro = dentroS ? e.target : e.source
    const g = gruppoDi.get(altro)
    if (!g) continue
    const dove = dentroS ? stubOut : stubIn
    if (!dove.has(g)) dove.set(g, { gruppo: g, n: 0, nomi: [] })
    const v = dove.get(g)
    v.n += 1
    if (v.nomi.length < 6) v.nomi.push(nomeDi.get(altro) ?? altro.split('::').pop())
  }

  // Tutto in colonne, stub compresi: chi entra a sinistra di tutto, chi riceve a destra di tutto. Così
  // nessuna freccia verso un vicino attraversa la fila delle card.
  const ultima = Math.max(0, presenti.length - 1)
  const elementi = [
    ...[...stubIn.values()].map((v) => ({ id: `stub:in:${v.gruppo}`, livello: -1, w: WR - 30, h: 40, stub: v, verso: 'in' })),
    ...ordinati.map((s) => ({ id: chiaveDi(s), livello: colonnaDi(s), w: WR, h: altezzaCard(displayName(s), WR), servizio: s })),
    ...[...stubOut.values()].map((v) => ({ id: `stub:out:${v.gruppo}`, livello: ultima + 1, w: WR - 30, h: 40, stub: v, verso: 'out' })),
  ]
  const pos = colonne(elementi, { gapX: 56, gapY: 26 })

  const nodes = elementi.map((el) => {
    if (el.stub)
      return {
        id: el.id,
        type: 'stub',
        position: pos.get(el.id),
        style: { width: el.w, height: el.h },
        data: { titolo: t(`topo.g.${el.stub.gruppo}`), n: el.stub.n, nomi: el.stub.nomi, verso: el.verso },
      }
    const s = el.servizio
    return {
      id: el.id,
      type: 'svc',
      position: pos.get(el.id),
      style: { width: el.w, height: el.h },
      data: {
        name: displayName(s),
        prefissi: familyPrefixes(dentro.map((x) => x.name)),
        type: s.type,
        // Una card gialla su un servizio sano non è una bugia: dice «dipende da qualcosa che non sta
        // bene», ed è l'informazione per cui si è scesi dentro al gruppo.
        color: rischi.has(chiaveDi(s)) && s.overall !== 'down' && s.overall !== 'degraded' ? STATUS_COLOR.degraded : STATUS_COLOR[s.overall] ?? STATUS_COLOR.unknown,
        rischio: rischi.get(chiaveDi(s)) ?? null,
        repliche: repliche(s),
        // «5 lo usano» sulla card: è la risposta alla prima delle due domande della pagina, e sulle
        // risorse condivise (un Redis, un database) è l'unica cosa che ne dice il peso.
        // L'ACCOUNT non si scrive: la pagina mostra un ambiente per volta, quindi sarebbe la stessa
        // parola su ogni card, e mangiava lo spazio dove finiva ellissato il resto.
        meta: [
          s.esterno ? (s.esterno.hosts ?? []).join(' · ') || t('topo.ext.meta') : s.type,
          usi.get(chiaveDi(s)) ? t('topo.usedBy', { n: usi.get(chiaveDi(s)) }) : null,
        ]
          .filter(Boolean)
          .join(' · '),
        title: s.esterno
          ? [s.name, ...(s.esterno.hosts ?? [])].join('\n')
          : [s.name, s.type, acctLabel(s)].filter(Boolean).join(' · '),
        servizio: s,
      },
    }
  })

  // Archi interni al gruppo, più quelli verso gli stub.
  const interni = (topo.edges ?? [])
    .filter((e) => chiaviDentro.has(e.source) && chiaviDentro.has(e.target))
    .map((e) => arco(e.source, e.target, e.vias, pos))
  const versoStub = []
  for (const e of topo.edges ?? []) {
    if (chiaviDentro.has(e.source) && !chiaviDentro.has(e.target)) {
      const g = gruppoDi.get(e.target)
      if (g) versoStub.push(arco(e.source, `stub:out:${g}`, e.vias, pos))
    } else if (!chiaviDentro.has(e.source) && chiaviDentro.has(e.target)) {
      const g = gruppoDi.get(e.source)
      if (g) versoStub.push(arco(`stub:in:${g}`, e.target, e.vias, pos))
    }
  }
  const unici = new Map(unisciReciproci([...interni, ...versoStub]).map((a) => [a.id, a]))

  const altezza = Math.max(...elementi.map((el) => (pos.get(el.id)?.y ?? 0) + el.h), 120)
  return { nodes, edges: [...unici.values()], membri: dentro, altezza }
}

function arco(source, target, vias = [], pos = new Map()) {
  const forte = isViaForte(vias)
  const colore = forte ? '#fa8c16' : '#8c8c8c'
  return {
    id: `${source}->${target}`,
    source,
    target,
    ...maniglie(pos.get(source), pos.get(target)),
    type: 'default',
    data: { vias, forte },
    style: { strokeDasharray: forte ? undefined : '6 5', stroke: colore },
    markerEnd: { type: 'arrowclosed', width: 12, height: 12, color: colore },
  }
}

// Repliche attive/desiderate: numeri, non una frase. Solo dove esistono (i servizi ECS).
export function repliche(s) {
  const r = s?.checks?.runtime
  if (!r || r.desiredCount == null) return null
  const attive = r.runningCount ?? 0
  return { testo: `${attive}/${r.desiredCount}`, male: attive < r.desiredCount }
}
