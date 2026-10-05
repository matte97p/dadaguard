import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Verdetto, Tabs, Lista, Sezione, Card, Pill, Rimedio, BloccoComando, ListaLink } from '../ui/index.js'
import { usePoll } from '../usePoll.js'
import PollStatus from '../components/PollStatus.jsx'
import Loading from '../components/Loading.jsx'
import { fmtAgo, fmtMs } from '../format.js'
import {
  avvioStorto,
  daGuardare,
  dataImmagine,
  digestCorto,
  durataFallite,
  filtraRighe,
  immagineRiferimento,
  linkAudit,
  dataRiferimento,
  giorniIndietro,
  macchinaIndietro,
  personaMacchina,
  ritardo,
  riepilogo,
  senzaVersione,
  ordinaDatabase,
  ordinaMacchine,
  ordinaPersone,
  ordinaSsh,
  problemaDatabase,
  problemaMacchina,
  problemaPersona,
  problemaSsh,
  tuttiIndietro,
} from '../accessi.js'
import './ops.css'

// Superficie "Accessi": chi entra dove e chi ha il dev-env indietro.
//
// Perché questa pagina esiste: i dati c'erano già tutti e non li guardava nessuno. Il 28/08/2026 un
// connector applicato con ruoli inesistenti ha chiuso fuori dal login tutto il team per due ore, e la
// notizia è arrivata come un messaggio in chat mentre la riga con la causa era nel log dal primo
// tentativo. Le due domande che la pagina deve chiudere sono: «chi non riesce a entrare, e perché» e
// «chi è rimasto indietro con l'immagine».
//
// ⚠️ Read-only per costruzione. I bottoni che AGISCONO stanno nella Web UI di Teleport, che ha l'audit
// e il replay: qui ci sono i link. Una piattaforma che osserva e che può anche scrivere diventa una
// via d'accesso, ed è il contrario del motivo per cui la guardi.
//
// ── Perché è fatta così (rifatta il 31/08/2026) ────────────────────────────────────────────────────
// La prima stesura mostrava tutto insieme: otto numeri in fila con lo stesso peso, quattro tabelle una
// sotto l'altra, un `Tag` con lo zero dentro in ogni cella e la data assoluta al secondo in ogni riga.
// Con sette persone e cinque macchine era già due schermate di roba dove niente spiccava, e le due
// domande di sopra si rispondevano leggendo, non guardando. Quattro decisioni, tutte nella stessa
// direzione (far emergere la riga che conta, non mostrare di più):
//   · UNA tabella per volta, scelta da un interruttore che porta il conteggio e un pallino quando
//     dentro c'è qualcosa da guardare: niente resta nascosto, e la pagina torna alta una schermata;
//   · gli zeri sono testo muto, non tag: in una tabella dove quasi tutto è zero i tag sono rumore, e
//     l'unica riga con un 5 non si distingue più;
//   · le date sono «3m fa» col timestamp intero nel tooltip: la domanda è «è di adesso?»;
//   · l'ordine di default mette in cima le righe con un problema (login fallite, immagine indietro,
//     sessione SSH aperta), perché in un guasto si guarda la prima riga, non la settima.
// E la finestra ora si sceglie: il server accettava `?ore=` da sempre (1..168) e la pagina chiedeva
// per sempre 24 ore, quindi «chi è entrato questa settimana» non era una domanda che si potesse fare.

// I gradini della finestra NON stanno piu' qui: li dichiara `server/finestre.conf` e li serve
// `/api/finestre`, cosi' la stessa decisione vale per tutte le pagine invece di essere ricopiata in
// ognuna. Il ripiego serve al primo caricamento e al caso in cui quella chiamata non risponda: senza,
// il controllo sparirebbe e la pagina resterebbe inchiodata al suo default.
const FINESTRE_RIPIEGO = [1, 6, 24, 168]

// Un conteggio che parla solo quando non è zero. Lo zero dentro una pillola pesa come il cinque: su
// una colonna dove quasi ogni cella è zero le pillole diventano una texture, e la cella che conta si
// perde.
function Conta({ n, livello = 'warn' }) {
  return n > 0 ? <Pill livello={livello}>{n}</Pill> : <span className="ui-faint">0</span>
}

// «3m fa» in chiaro, il timestamp intero al passaggio del mouse. Quattro liste con
// `31/08/2026, 15:07:09` in ogni riga sono quattro colonne di rumore per rispondere a una domanda che
// è sempre relativa.
function Quando({ ts, t, lang }) {
  if (!ts) return <span className="ui-faint">-</span>
  return (
    <span className="ui-when" style={{ textAlign: 'left', whiteSpace: 'nowrap' }} title={new Date(ts).toLocaleString(lang === 'it' ? 'it-IT' : 'en-GB')}>
      {fmtAgo(ts, t)}
    </span>
  )
}

// La data in chiaro, senza l'ora: per «quando e' stata costruita quest'immagine» il minuto non serve,
// e una data assoluta e' quello che si chiede quando si vuole sapere se la golden image e' stata
// aggiornata (il relativo, «8g fa», risponde a un'altra domanda e la pagina lo dice a parte).
const dataCorta = (ts, lang) => new Date(ts).toLocaleDateString(lang === 'it' ? 'it-IT' : 'en-GB')

// Un nome che porta al suo audit in Teleport, quando la config dice come. Senza modello resta testo:
// la pagina promette che le sessioni si rivedono, e un link che non porta da nessuna parte è peggio
// della promessa non mantenuta.
function Nome({ href, children }) {
  if (!href) return <span>{children}</span>
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--brand)' }}>
      {children}
    </a>
  )
}

// La finestra come pillole della barra (`ui-seg`): le etichette sono le stesse del controllo di prima.
function Finestra({ ore, gradini, onChange, t }) {
  if (!gradini?.length || gradini.length < 2) return null
  const etichetta = (h) => (h < 24 ? `${h}h` : h % 24 === 0 && h < 168 ? `${h / 24}g` : h === 168 ? '7g' : `${Math.round(h / 24)}g`)
  return (
    <div className="ui-seg" role="group" aria-label={t('finestra.label')}>
      {gradini.map((h) => (
        <button key={h} type="button" aria-pressed={ore === h} onClick={() => onChange(h)}>
          {etichetta(h)}
        </button>
      ))}
    </div>
  )
}

// Le viste di PRIMA, che restano valide come indirizzo. Erano sei tabelle e sei interruttori, e per
// sapere com'era andata la giornata bisognava aprirli tutti e sei; ora sono quattro domande, e due di
// quelle raccolgono due tabelle ciascuna. Un `?vista=persone` mandato in chat il mese scorso deve
// continuare ad aprire la pagina giusta invece di cadere sulla prima: un link rotto lo scopre chi lo
// riceve, non chi lo ha mandato.
const VISTE_VECCHIE = { persone: 'chi', ssh: 'chi', mappa: 'chiHaCosa', team: 'chiHaCosa' }
const normalizzaVista = (v) => VISTE_VECCHIE[v] ?? v

export default function AccessiPage({ t, lang }) {
  // La finestra la sceglie chi guarda, e vale solo per l'AUDIT: l'heartbeat è per definizione «l'ultima
  // riga di ogni macchina» su sette giorni, e restringerlo a 24 ore farebbe sparire dalla mappa proprio
  // le macchine ferme, cioè quelle rimaste indietro.
  // ⚠️ Parte da UN'ORA e non da 24: questa pagina si apre durante un guasto, e la finestra larga
  // costava l'attesa che l'ha fatta sembrare rotta. Chi vuole guardare indietro lo chiede col
  // controllo qui sopra, e il massimo lo impone il server.
  const [ore, setOre] = useState(1)
  const [gradini, setGradini] = useState(FINESTRE_RIPIEGO)
  useEffect(() => {
    fetch('/api/finestre')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const f = d?.finestre?.find((x) => x.chiave === 'teleport')
        if (f?.max) setGradini(FINESTRE_RIPIEGO.filter((g) => g <= f.max))
      })
      .catch(() => {})
  }, [])
  // La tabella scelta sta nell'URL, e in mancanza nell'ultima scelta ricordata: così «guarda la riga
  // di quella macchina» si manda come link invece che come istruzione, che è lo stesso motivo per cui
  // la pagina IAM prende la sua lente da `?view=`.
  const [params, setParams] = useSearchParams()
  const [ricordata, setRicordata] = useState(() =>
    typeof localStorage === 'undefined' ? 'chi' : normalizzaVista(localStorage.getItem('dadaguard-accessi-view') ?? 'chi'),
  )
  const vista = normalizzaVista(params.get('vista') ?? ricordata)
  const [soloProblemi, setSoloProblemi] = useState(false)
  const [query, setQuery] = useState('')

  // ⚠️ Si normalizza QUI e non solo in lettura: i link della sintesi in cima chiedono ancora la vista
  // per NOME della tabella (`persone`, `ssh`), che e' il verso giusto per chi li scrive, e senza questo
  // passaggio scriverebbero nell'URL una vista che non esiste piu'.
  const scegliVista = (v) => {
    const scelta = normalizzaVista(v)
    setRicordata(scelta)
    if (typeof localStorage !== 'undefined') localStorage.setItem('dadaguard-accessi-view', scelta)
    const prossimi = new URLSearchParams(params)
    prossimi.set('vista', scelta)
    setParams(prossimi, { replace: true })
  }

  // 20 secondi come le altre pagine, e con l'indicatore «aggiornato N fa»: senza, una vista che si
  // guarda durante un guasto non dice se quello che vedi e' di adesso o di dieci minuti fa.
  const { data: dati, loading, refreshing, error: errore, lastUpdated } = usePoll(`/api/teleport?ore=${ore}`, {
    intervalMs: 20000,
  })

  // La MAPPA (chi ha cosa) sta su un'altra lettura e su un'altra finestra: tre fonti incrociate, e la
  // domanda non e' «cosa succede adesso» ma «chi ha cosa», quindi sette giorni e un giro ogni due
  // minuti. Si carica SOLO quando la sua tabella e' quella aperta: sono tre chiamate AWS, e farle a
  // ogni giro anche a chi guarda le login fallite sarebbe lavoro buttato.
  const mappaAttiva = vista === 'chiHaCosa'
  const { data: mappa, refreshing: mappaRefreshing, error: mappaErrore } = usePoll('/api/accessi/mappa?ore=168', {
    intervalMs: 120000,
    enabled: mappaAttiva,
  })

  const audit = dati?.audit ?? {}
  const battito = dati?.heartbeat ?? {}

  // L'immagine con cui si confrontano le altre, e da DOVE viene: la versione attesa dalla config se
  // c'è, altrimenti la più recente che qualcuno ha avviato. Sono due cose diverse e la pagina lo dice,
  // perché col ripiego la colonna «indietro» non sa vedere il caso in cui sono indietro tutti.
  const riferimento = useMemo(
    () => immagineRiferimento(battito.macchine ?? [], battito.attesa ?? null),
    [battito.macchine, battito.attesa],
  )
  // La data piu' recente vista: con questa «indietro» e' un ordine e non una stima, quindi non serve
  // piu' la versione attesa in config per poterlo dire (resta la forma piu' forte, se c'e').
  const dataRif = useMemo(() => dataRiferimento(battito.macchine ?? []), [battito.macchine])
  const indietro = (m) => ritardo(m, riferimento, dataRif).indietro
  const quantoIndietro = (m) => ritardo(m, riferimento, dataRif).giorni
  const versioniInGiro = battito.versioni?.length ?? 0
  const macchineIndietro = (battito.macchine ?? []).filter((m) => ritardo(m, riferimento, dataRif).indietro)
  // I nomi che Teleport conosce: servono a scegliere quale dei due nomi della stessa persona mostrare
  // sulla riga di una macchina (l'heartbeat manda l'utente di sistema quando non c'è una sessione).
  const utentiNoti = useMemo(() => new Set((audit.persone ?? []).map((p) => p.utente)), [audit.persone])

  const persone = useMemo(() => ordinaPersone(audit.persone ?? []), [audit.persone])
  const database = useMemo(() => ordinaDatabase(audit.database ?? []), [audit.database])
  const macchine = useMemo(
    () => ordinaMacchine(battito.macchine ?? [], riferimento, dataRif),
    [battito.macchine, riferimento, dataRif],
  )
  const ssh = useMemo(() => ordinaSsh(audit.ssh ?? []), [audit.ssh])

  if (errore && !dati) return <div className="ui-readwarn">{String(errore)}</div>
  if (loading || !dati) return <Loading text={t('accessi.caricamento')} />

  // Senza la sezione `teleport:` nella config non si mostra un vuoto che sembra un guasto: si dice
  // cosa manca. È la stessa scelta del resto dell'app (nessun nome di risorsa cablato nel codice).
  if (!dati.configurato) {
    return (
      <div className="ui-pagina">
        <Verdetto resto={t('accessi.title')} dettaglio={t('accessi.desc')} />
        <Lista vuoto={t('accessi.nonConfigurato')}>{[]}</Lista>
      </div>
    )
  }

  // ⚠️ «1 macchine» e «1 login fallite» sono la prima cosa che si nota in una riga che deve leggersi in
  // un colpo d'occhio. Il dizionario non ha i plurali: ogni frase ha la sua forma per UNO, e si sceglie
  // qui in base al numero. Sta PRIMA delle righe che la usano: un `const` letto prima della sua
  // dichiarazione e' un `ReferenceError` a ogni render, e qui nessuna prova renderizza un componente.
  const frase = (chiave, n, extra = {}) => t(n === 1 ? `${chiave}.uno` : chiave, { n, ...extra })

  // Tanti nomi uguali sono rumore: sopra i tre si mostra il conteggio e i nomi vanno nel `title`.
  // `marca`: quali voci contano piu' delle altre (chi ha SCRITTO, fra chi ha solo letto), che diventano
  // una pillola arancio. Senza, la cella dice «tre persone» e la domanda vera («chi ha scritto?»)
  // resta senza risposta.
  const elencoCorto = (valori = [], vuoto = null, marca = () => false) => {
    if (!valori.length) return vuoto
    if (valori.length <= 3)
      return (
        <span className="ui-who">
          {valori.map((v) =>
            marca(v) ? (
              <Pill key={v} livello="warn">
                {v}
              </Pill>
            ) : (
              <b key={v} style={{ marginInlineEnd: 4 }}>
                {v}
              </b>
            ),
          )}
        </span>
      )
    return (
      <span className="ui-who" title={valori.join(' · ')}>
        <b>{t('accessi.mappa.quanti', { n: valori.length })}</b>
      </span>
    )
  }
  // Le righe di sotto: piccole, grigie, una per fatto. Sono il secondo livello di una cella.
  const sotto = (testo, key) =>
    testo ? (
      <span key={key} className="ui-hint">
        {testo}
      </span>
    ) : null

  // ── Le righe delle sei liste ──────────────────────────────────────────────────────────────────────
  // Ogni lista e' una griglia di celle; la prima colonna, quando la lista ha una nozione di problema, e'
  // la pillola di stato, che e' la cosa che si guarda scorrendo dall'alto.

  // ⚠️ Il motivo dell'ultimo rifiuto sta SOTTO AL NOME e non in una colonna sua: e' la frase che
  // distingue «sessione scaduta» da «ruolo che non esiste», cioe' una persona sola da tutto il team
  // fuori, e in fondo alla riga la leggeva solo chi arrivava fin la'. Per intero, non troncata.
  const cellePersona = (r) => [
    <span key="n" className="ui-name">
      <Nome href={linkAudit(dati.auditUserUrl, 'utente', r.utente)}>{r.utente}</Nome>
      {r.motivo && <span className="ui-hint" style={{ color: 'var(--ink)' }}>{r.motivo}</span>}
      <small>
        <Quando ts={r.ultima} t={t} lang={lang} />
      </small>
    </span>,
    // Le fallite E le riuscite: con un numero solo chi aveva otto login buone e due fallite risultava
    // «2 fallite» e sembrava fuori, mentre stava lavorando. E quanto è durata la raffica: tre fallite
    // in due minuti sono un guasto in corso, tre in un giorno sono tre giornate diverse.
    <span key="l" className="ui-what">
      <span className={r.loginOk ? undefined : 'ui-faint'}>{t('accessi.okN', { n: r.loginOk ?? 0 })}</span>{' '}
      {r.loginFallite > 0 && <Pill livello="crit">{t('accessi.falliteN', { n: r.loginFallite })}</Pill>}
      {durataFallite(r) && sotto(t('accessi.inTempo', { durata: fmtMs(durataFallite(r)) }))}
    </span>,
    // ⚠️ Le sessioni riuscite e i tentativi RIFIUTATI nella stessa cella, ma separati: sommarli e' il
    // modo in cui un accesso negato sparisce. E sotto COSA ha chiesto, non solo quante volte: il rimedio
    // sta nella coppia utente+database, e il conteggio da solo la nasconde.
    <span key="d" className="ui-what">
      <span className={r.sessioniDb ? undefined : 'ui-faint'}>{r.sessioniDb ?? 0}</span>{' '}
      {r.sessioniDbNegate > 0 && <Pill livello="crit">{t('accessi.dbNegateN', { n: r.sessioniDbNegate })}</Pill>}
      {(r.negati ?? []).map((n) =>
        sotto(t('accessi.negatoCombo', { n: n.quante, dbUser: n.dbUser, db: n.nome, servizio: n.servizio }), `${n.dbUser}/${n.servizio}/${n.nome}`),
      )}
    </span>,
    // Query e scritture in una cella, e sotto i NOMI dei database: «124 query» non si traduce in niente,
    // la domanda dopo e' sempre «su cosa?».
    <span key="a" className="ui-what">
      {r.query ? (
        <>
          {t('accessi.queryN', { n: r.query })}{' '}
          {r.scritture > 0 && <Pill livello="warn">{frase('accessi.scrittureN', r.scritture)}</Pill>}
          <span className="ui-hint">{elencoCorto((r.db ?? []).map((d) => d.nome))}</span>
        </>
      ) : (
        <span className="ui-faint">0</span>
      )}
    </span>,
  ]

  // Chi è entrato sulle macchine: la metà che l'heartbeat non copre. L'heartbeat dice chi è rimasto
  // indietro, questa dice chi è andato a vedere, ed è la traccia che rende accettabile il primo.
  const celleSsh = (r) => [
    <span key="m" className="ui-name">
      <Nome href={linkAudit(dati.auditNodeUrl, 'macchina', r.macchina)}>{r.macchina}</Nome>
      <small>
        <Quando ts={r.ultima} t={t} lang={lang} />
      </small>
    </span>,
    <span key="c">{elencoCorto(r.chi ?? [], <span className="ui-faint">-</span>)}</span>,
    // Sessioni e aperte nella stessa cella: «4 · 1 aperta» in rosso. La seconda e' l'unica delle due a
    // cui si reagisce subito.
    <span key="s" className="ui-what">
      <span className={r.sessioni ? undefined : 'ui-faint'}>{r.sessioni ?? 0}</span>{' '}
      {r.aperte > 0 && <Pill livello="crit">{frase('accessi.aperteN', r.aperte)}</Pill>}
    </span>,
  ]

  // Nome, ambiente e servizio in una cella sola: il servizio e' il dettaglio che serve dopo aver
  // riconosciuto il database, non prima. Un `?` è il nome che il log non aveva (Redis non manda
  // `db_name`): si scrive «-», che è la stessa informazione senza sembrare un errore di lettura.
  const celleDatabase = (r) => [
    <span key="n" className="ui-name">
      {r.nome && r.nome !== '?' ? r.nome : <span className="ui-faint">-</span>}{' '}
      {r.ambiente && <Pill livello={r.ambiente === 'prod' ? 'crit' : 'off'}>{r.ambiente}</Pill>}
      <small>{r.servizio}</small>
    </span>,
    <span key="a" className="ui-what">
      {t('accessi.queryN', { n: r.query ?? 0 })}{' '}
      {r.scritture > 0 && <Pill livello={r.ambiente === 'prod' ? 'crit' : 'warn'}>{frase('accessi.scrittureN', r.scritture)}</Pill>}
    </span>,
    // ⚠️ I NOMI, non il numero: e' la cella su cui si risponde a «chi ha scritto in produzione?», e chi
    // ha scritto e' in arancio.
    <span key="p">{elencoCorto(r.chi ?? [], <span className="ui-faint">-</span>, (nome) => (r.scriventi ?? []).includes(nome))}</span>,
  ]

  const celleMacchina = (r) => {
    const { nome, altri } = personaMacchina(r, utentiNoti)
    return [
      // ⚠️ Il LATO e' un attributo della macchina, non una colonna. L'esito dell'avvio compare SOLO
      // quando non è `ok`: una colonna che dice «ok» su ogni riga è una colonna che nessuno legge. E il
      // comando per entrare, copiabile: il MODELLO arriva dalla config (`teleport.sshCommand`, con
      // `{macchina}` dentro), e solo per `lato: host`, perche' il container non e' raggiungibile.
      <span key="m" className="ui-name">
        <Nome href={linkAudit(dati.auditNodeUrl, 'macchina', r.macchina)}>{r.macchina}</Nome>{' '}
        {r.lato && (
          <span className="ui-who">
            <b>{r.lato}</b>
          </span>
        )}{' '}
        {avvioStorto(r) && <Pill livello="warn">{t('accessi.esitoNonOk', { esito: r.esito })}</Pill>}
        {dati.sshCommand && r.lato === 'host' && <BloccoComando comando={dati.sshCommand.replace('{macchina}', r.macchina)} t={t} />}
      </span>,
      // Fra i nomi con cui la stessa persona è comparsa si mostra quello che Teleport conosce, e gli
      // altri stanno nel `title`: senza questa scelta la stessa persona sembrava due.
      <span key="p" title={altri.length ? t('accessi.altriNomi', { nomi: altri.join(', ') }) : undefined}>
        {nome ? <Nome href={linkAudit(dati.auditUserUrl, 'utente', nome)}>{nome}</Nome> : <span className="ui-faint">-</span>}
      </span>,
      // Il digest corto, «indietro» e la data dell'immagine: è la mezza riga che risponde alla seconda
      // domanda della pagina. «Non dichiarata» non è una versione vecchia: è una riga in cui l'avvio non
      // ha potuto leggere l'immagine. ⚠️ «Indietro» è un'accusa e si fa solo quando il confronto è un
      // fatto (versione attesa in config o data dell'immagine), come decide `ritardo()`.
      <span key="i" className="ui-what">
        {senzaVersione(r) ? (
          <span className="ui-faint">{t('accessi.img.nonDichiarata')}</span>
        ) : (
          <code className="ui-mono" title={r.immagine} style={{ userSelect: 'all' }}>
            {digestCorto(r.immagine)}
          </code>
        )}{' '}
        {indietro(r) && (
          <Pill livello="warn">
            {quantoIndietro(r) != null ? frase('accessi.img.indietroGiorni', quantoIndietro(r)) : t('accessi.img.indietro')}
          </Pill>
        )}
        {dataImmagine(r) != null && sotto(t('accessi.img.del', { data: dataCorta(dataImmagine(r), lang) }))}
      </span>,
      // Il numero e i NOMI dei tool mancanti, quando l'heartbeat li manda: «2» non dice cosa installare.
      <span key="t">{r.toolMancanti > 0 && (r.toolMancantiNomi ?? []).length ? elencoCorto(r.toolMancantiNomi) : <Conta n={r.toolMancanti} />}</span>,
      // Quando + quanto ci ha messo: «il dev-env qui parte in quattro minuti» è metà dei «a me non
      // funziona».
      <span key="q" className="ui-what">
        <Quando ts={r.quando} t={t} lang={lang} />
        {r.durata != null && sotto(t('accessi.avviatoIn', { durata: fmtMs(r.durata * 1000) }))}
      </span>,
    ]
  }

  // ── La mappa: una riga per persona, una per team ────────────────────────────────────────────────
  // I permessi del portale si mostrano RAGGRUPPATI per account e non uno per uno: la domanda («quanto
  // puo' fare qui dentro?») si risponde col numero, mentre i nomi stanno nel `title`.
  const perAccount = (permessi = []) => {
    const m = new Map()
    for (const p of permessi) m.set(p.account, [...(m.get(p.account) ?? []), p.permissionSet])
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }

  // Cosa ha risposto e cosa no. Serve perche' una fonte muta si legge come «questa persona non ha
  // niente»: il parametro con la mappa dei team che manca, o Identity Center non leggibile, devono
  // dirsi in pagina, non restare un vuoto che sembra un fatto.
  const fonti = mappa?.fonti ?? {}
  const notaFonti =
    [
      fonti.ruoli?.assente ? t('accessi.mappa.senzaMappa', { param: fonti.ruoli.assente }) : null,
      fonti.ruoli?.errore ? t('accessi.mappa.fonteRotta', { fonte: 'SSM', motivo: fonti.ruoli.errore }) : null,
      fonti.sso?.errore ? t('accessi.mappa.fonteRotta', { fonte: 'Identity Center', motivo: fonti.sso.errore }) : null,
      fonti.teleport?.errore ? t('accessi.mappa.fonteRotta', { fonte: 'Teleport', motivo: fonti.teleport.errore }) : null,
      mappaErrore ? String(mappaErrore) : null,
    ]
      .filter(Boolean)
      .join(' · ') || null

  const celleMappa = (r) => [
    // Chi non entra su Teleport non e' senza accessi: ha quelli del portale, e questa e' la riga da
    // guardare quando ci si chiede a chi e' rimasto addosso un permesso.
    <span key="p" className="ui-name">
      <Nome href={linkAudit(dati.auditUserUrl, 'utente', r.persona)}>{r.persona}</Nome>
      {r.soloSso && <small>{t('accessi.mappa.soloPortale')}</small>}
    </span>,
    <span key="t">
      {r.teamsNoti ? (
        elencoCorto(r.teams, <span className="ui-faint">{t('accessi.mappa.nessunTeam')}</span>)
      ) : (
        <span className="ui-faint">{t('accessi.mappa.senzaLogin')}</span>
      )}
    </span>,
    // Un team che la mappa non nomina non concede niente su Teleport: di norma e' un team dei
    // repository, e senza questa nota la riga sembra una mappa incompleta.
    <span key="r" className="ui-what">
      {r.ruoli.length ? (
        <span title={r.ruoli.join(' · ')}>
          <Pill livello="ok">{t('accessi.mappa.quanti', { n: r.ruoli.length })}</Pill>
        </span>
      ) : (
        <span className="ui-faint">0</span>
      )}
      {r.teamsSenzaRuoli?.length > 0 && (
        <span className="ui-hint" title={r.teamsSenzaRuoli.join(' · ')}>
          {t('accessi.mappa.soloRepoN', { n: r.teamsSenzaRuoli.length })}
        </span>
      )}
    </span>,
    <span key="s" className="ui-who">
      {r.permessi.length ? (
        perAccount(r.permessi).map(([account, ps]) => (
          <b key={account} title={ps.join(' · ')} style={{ marginInlineEnd: 4 }}>
            {`${account} · ${ps.length}`}
          </b>
        ))
      ) : (
        <span className="ui-faint">{t('accessi.mappa.nessunPortale')}</span>
      )}
    </span>,
    r.ultimoLogin ? <Quando key="u" ts={r.ultimoLogin} t={t} lang={lang} /> : <span key="u" className="ui-faint">{t('accessi.mappa.mai')}</span>,
  ]

  const celleTeam = (r) => [
    <span key="n" className="ui-name">
      {r.team}
      {r.soloRepo && <small>{t('accessi.mappa.soloRepo')}</small>}
    </span>,
    <span key="r">{elencoCorto(r.ruoli, <span className="ui-faint">0</span>)}</span>,
    <span key="m">{elencoCorto(r.membri, <span className="ui-faint">{t('accessi.mappa.nessunMembro')}</span>)}</span>,
  ]

  // I segnali che valgono per TUTTA la pagina, contati una volta: decidono il verdetto in cima.
  const quante = daGuardare(audit, battito, riferimento)
  const sintesi = riepilogo(audit, battito, riferimento)
  // La finestra del DATO, non quella chiesta: quando il server sta ancora rileggendo (sette giorni di
  // log non sono istantanei) i numeri sono ancora quelli di prima, e va detto invece di lasciare
  // l'interruttore su «7g» sopra dei numeri di 24 ore.
  const finestraDetta =
    audit.ore && audit.ore !== ore
      ? `${t('accessi.ultimeOre', { n: audit.ore })} · ${t('accessi.inAggiornamento')}`
      : t('accessi.ultimeOre', { n: audit.ore ?? ore })
  const nessunoAggiornato = tuttiIndietro(battito.macchine ?? [], riferimento)

  // ── Le LISTE, e poi le viste che le raccolgono ────────────────────────────────────────────────
  // Le domande sono quattro, non sei: «chi entra» e' la stessa domanda per le login e per le sessioni
  // sulle macchine, «chi ha cosa» la stessa per le persone e per i team. Quindi una vista puo' avere
  // piu' liste, la scheda conta e segnala per tutte quelle che ha dentro, e il filtro le attraversa.
  // L'ORDINE e' quello dell'urgenza: prima chi non riesce a entrare, poi cosa si sta toccando sui
  // database, poi chi ha il dev-env indietro, e in fondo gli elenchi da consultare.
  const PILLOLA = '104px '
  const tabellaPersone = {
    titolo: t('accessi.persone'),
    righe: persone,
    celle: cellePersona,
    colonne: [t('accessi.col.stato'), t('accessi.col.persona'), t('accessi.col.login'), t('accessi.col.sessioniDb'), t('accessi.col.attivita')],
    griglia: `${PILLOLA}minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1.5fr) minmax(0, 1.4fr)`,
    rowKey: (r) => r.utente,
    problema: problemaPersona,
    livello: 'crit',
    // Cercare `dev_readwrite` deve trovare chi l'ha chiesto: e' il verso da cui arriva la domanda
    // quando il nome della persona non lo si sa ancora.
    cerca: (p) => [p.utente, p.motivo, ...(p.negati ?? []).flatMap((n) => [n.dbUser, n.nome, n.servizio])],
    vuoto: t('accessi.nessunAccesso'),
    finestra: finestraDetta,
  }

  const tabellaSsh = {
    titolo: t('accessi.ssh'),
    righe: ssh,
    celle: celleSsh,
    colonne: [t('accessi.col.stato'), t('accessi.col.macchina'), t('accessi.col.chiEntrato'), t('accessi.col.quanteSessioni')],
    griglia: `${PILLOLA}minmax(0, 1.2fr) minmax(0, 1.5fr) minmax(0, 1fr)`,
    rowKey: (r) => r.macchina,
    problema: problemaSsh,
    livello: 'crit',
    cerca: (m) => [m.macchina, ...(m.chi ?? [])],
    vuoto: t('accessi.nessunaSsh'),
    finestra: finestraDetta,
    nota: t('accessi.sshRegistrate'),
  }

  const tabellaDatabase = {
    titolo: t('accessi.database'),
    righe: database,
    celle: celleDatabase,
    colonne: [t('accessi.col.stato'), t('accessi.col.database'), t('accessi.col.attivita'), t('accessi.col.quantePersone')],
    griglia: `${PILLOLA}minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1.5fr)`,
    rowKey: (r) => `${r.servizio}/${r.nome}`,
    problema: problemaDatabase,
    livello: 'crit',
    cerca: (d) => [d.nome, d.servizio, d.ambiente],
    vuoto: t('accessi.nessunaQuery'),
    finestra: finestraDetta,
  }

  const tabellaMacchine = {
    titolo: t('accessi.devEnv'),
    righe: macchine,
    celle: celleMacchina,
    colonne: [
      t('accessi.col.stato'),
      t('accessi.col.macchina'),
      t('accessi.col.persona'),
      riferimento.fonte === 'config' ? t('accessi.col.immagineAttesa') : t('accessi.col.immagine'),
      t('accessi.col.tool'),
      t('accessi.col.ultimoAvvio'),
    ],
    griglia: `${PILLOLA}minmax(0, 1.6fr) minmax(0, 0.9fr) minmax(0, 1.3fr) minmax(0, 0.8fr) minmax(0, 0.9fr)`,
    rowKey: (r) => `${r.macchina}/${r.lato}`,
    problema: (m) => problemaMacchina(m, riferimento, dataRif),
    livello: 'warn',
    cerca: (m) => [m.macchina, m.utente, m.immagine],
    vuoto: t('accessi.nessunAvvio'),
    // ⚠️ La data della GOLDEN IMAGE, in chiaro e non solo come «indietro di N giorni»: chi apre questa
    // vista chiede prima di tutto «l'immagine e' stata aggiornata?», e un elenco di digest non risponde.
    nota:
      dataRif != null
        ? t('accessi.golden.del', {
            digest: digestCorto(riferimento.immagine) || '-',
            data: dataCorta(dataRif, lang),
            quando: fmtAgo(dataRif, t),
          })
        : t('accessi.golden.senzaData'),
    // Su cosa si sta confrontando, detto in una riga: la versione attesa dalla config, oppure la DATA
    // dell'immagine più recente vista (che è un ordine), oppure niente.
    finestra: `${t('accessi.ultimiGiorni', { n: battito.giorni ?? 7 })} · ${
      riferimento.fonte === 'config' ? t('accessi.fonte.config') : dataRif != null ? t('accessi.fonte.data') : t('accessi.fonte.vista')
    }`,
  }

  // Le due liste di «chi ha cosa»: nessuna pillola di stato, e non e' una dimenticanza. Qui non c'e'
  // una riga rotta da far emergere, c'e' un elenco da consultare.
  const tabellaMappa = {
    titolo: t('accessi.mappa.persone'),
    righe: mappa?.persone ?? [],
    celle: celleMappa,
    colonne: [t('accessi.col.persona'), t('accessi.mappa.col.team'), t('accessi.mappa.col.ruoli'), t('accessi.mappa.col.portale'), t('accessi.mappa.col.ultimoLogin')],
    griglia: 'minmax(0, 1.1fr) minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1.5fr) 100px',
    rowKey: (r) => r.persona,
    problema: () => false,
    senzaStato: true,
    livello: 'warn',
    cerca: (r) => [r.persona, r.ssoUtente, ...(r.teams ?? []), ...(r.ruoli ?? []), ...(r.gruppiSso ?? [])],
    vuoto: t('accessi.mappa.vuoto'),
    finestra: t('accessi.mappa.finestra', { n: Math.round((mappa?.ore ?? 168) / 24) }),
    nota: notaFonti,
  }

  const tabellaTeam = {
    titolo: t('accessi.mappa.team'),
    righe: mappa?.teams ?? [],
    celle: celleTeam,
    colonne: [t('accessi.mappa.col.teamNome'), t('accessi.mappa.col.ruoli'), t('accessi.mappa.col.membri')],
    griglia: 'minmax(0, 1fr) minmax(0, 1.5fr) minmax(0, 1.5fr)',
    rowKey: (r) => r.team,
    problema: () => false,
    senzaStato: true,
    livello: 'warn',
    cerca: (r) => [r.team, ...(r.ruoli ?? []), ...(r.membri ?? [])],
    vuoto: t('accessi.mappa.vuotoTeam'),
    finestra: t('accessi.mappa.finestra', { n: Math.round((mappa?.ore ?? 168) / 24) }),
    nota: notaFonti,
  }

  // I nomi delle viste sono la DOMANDA a cui rispondono, non il nome della tabella: chi apre la pagina
  // durante un guasto non sa cosa c'e' dentro «SSH».
  const viste = [
    { value: 'chi', label: t('accessi.view.chi'), tabelle: [tabellaPersone, tabellaSsh] },
    { value: 'database', label: t('accessi.view.database'), tabelle: [tabellaDatabase] },
    { value: 'devEnv', label: t('accessi.view.devEnv'), tabelle: [tabellaMacchine] },
    { value: 'chiHaCosa', label: t('accessi.view.chiHaCosa'), tabelle: [tabellaMappa, tabellaTeam] },
  ]

  const attiva = viste.find((v) => v.value === vista) ?? viste[0]
  // Il filtro e la ricerca attraversano TUTTE le liste della vista: una riga nascosta in una lista e
  // mostrata nell'altra sarebbe lo stesso interruttore con due significati.
  const mostrate = attiva.tabelle.map((tb) => ({
    ...tb,
    filtrate: filtraRighe(tb.righe, { problema: tb.problema, cerca: tb.cerca, query, soloProblemi }),
  }))
  const filtrato = Boolean(query.trim()) || soloProblemi
  // Quante righe di una vista chiedono un intervento: il numero sulla scheda vale per tutte le sue
  // liste, sennò una scheda chiusa nasconde un segnale. Senza problemi la scheda porta il totale.
  const quanteRighe = (v) => v.tabelle.reduce((n, tb) => n + tb.righe.length, 0)
  const quantiGuasti = (v) => v.tabelle.reduce((n, tb) => n + tb.righe.filter(tb.problema).length, 0)

  // ── Il verdetto ───────────────────────────────────────────────────────────────────────────────
  // Sulla vista dev-env risponde a «chi non ha aggiornato», sulle altre a «c'e' qualcosa da guardare?».
  // ⚠️ I casi del dev-env restano quattro e nessuno e' stato fuso: «non si puo' dire» NON e' «va tutto
  // bene» (senza date l'ordine fra le immagini non esiste, quindi indietro non si dichiara).
  const verdettoDevEnv = () => {
    const tot = (battito.macchine ?? []).length
    if (tot === 0) return null
    const senza = battito.senzaVersione ?? 0
    const coda = senza > 0 ? ` ${t('accessi.verdetto.senzaVersioneN', { n: senza })}` : ''
    if (dataRif == null && riferimento.fonte !== 'config')
      return { livello: 'info', forte: t('accessi.verdetto.nonSiSaTitolo', { n: versioniInGiro }), dettaglio: t('accessi.verdetto.nonSiSa') + coda }
    if (nessunoAggiornato)
      return { livello: 'crit', forte: t('accessi.verdetto.nessunoTitolo', { n: tot }), dettaglio: t('accessi.verdetto.nessuno') + coda }
    if (macchineIndietro.length > 0) {
      const giorni = Math.max(...macchineIndietro.map((m) => quantoIndietro(m) ?? 0))
      // I NOMI di chi manca, non solo quanti: e' la domanda successiva, sempre.
      const chi = [...new Set(macchineIndietro.map((m) => m.utente).filter(Boolean))]
      return {
        livello: 'warn',
        forte: t('accessi.verdetto.inPariTitolo', { ok: tot - macchineIndietro.length, tot }),
        dettaglio:
          (chi.length
            ? t('accessi.verdetto.indietroChi', { n: macchineIndietro.length, g: giorni, chi: chi.join(', ') })
            : t('accessi.verdetto.indietro', { n: macchineIndietro.length, g: giorni })) + coda,
      }
    }
    return {
      livello: 'ok',
      forte: t('accessi.verdetto.tuttiTitolo', { n: tot }),
      dettaglio: (dataRif != null ? t('accessi.verdetto.tutti', { quando: fmtAgo(dataRif, t) }) : '') + coda,
    }
  }
  // Le frasi della sintesi, una per cosa trovata: la prima e' la parte colorata del verdetto, la
  // seconda la segue dopo la virgola, e tutte restano sotto come inviti che aprono la scheda giusta.
  const fraseSintesi = (v) =>
    v.k === 'indietro'
      ? frase('accessi.sintesi.indietro', v.n, { g: v.giorni })
      : v.k === 'scritture'
        ? frase(v.prod ? 'accessi.sintesi.scrittureProd' : 'accessi.sintesi.scritture', v.n, { dove: v.dove.join(', ') }) +
          (v.altrove > 0 ? ` ${frase('accessi.sintesi.altrove', v.altrove)}` : '')
        : v.k === 'versioni'
          ? t(v.tutti ? 'accessi.sintesi.versioniTutti' : 'accessi.sintesi.versioni', { n: v.n })
          : frase(`accessi.sintesi.${v.k}`, v.n)
  const grave = (audit.loginFallite ?? 0) > 0 || (audit.sessioniDbNegate ?? 0) > 0 || (audit.sshAperte ?? 0) > 0
  const generale =
    quante === 0 || sintesi.trovato.length === 0
      ? { livello: 'ok', forte: t('accessi.tuttoTranquillo'), dettaglio: `${finestraDetta} · ${t('accessi.v.fonti')}` }
      : {
          livello: grave ? 'crit' : 'warn',
          forte: fraseSintesi(sintesi.trovato[0]),
          resto: sintesi.trovato[1] ? `, ${fraseSintesi(sintesi.trovato[1])}` : null,
          dettaglio: `${finestraDetta} · ${t('accessi.v.fonti')}`,
        }
  const v = (attiva.value === 'devEnv' && verdettoDevEnv()) || generale
  const errori = [audit.errore, battito.errore].filter(Boolean)

  return (
    <div className="ui-pagina">
      <Verdetto
        livello={errori.length ? 'warn' : v.livello}
        forte={v.forte}
        resto={v.resto}
        dettaglio={v.dettaglio}
        extra={<PollStatus lastUpdated={lastUpdated} refreshing={refreshing || mappaRefreshing} t={t} />}
      />

      {/* Le cose trovate, ognuna un invito che apre la scheda giusta, e sotto quello che e' stato
          guardato senza trovare niente: «a posto» e' una risposta, non un vuoto. */}
      {sintesi.trovato.length > 0 && (
        <div className="ui-filtri">
          <b style={{ color: 'var(--ink)' }}>{t('accessi.sintesi.trovato')}</b>
          {sintesi.trovato.map((x) => (
            <button key={x.k} type="button" className="ui-azione" onClick={() => scegliVista(x.vista)}>
              {fraseSintesi(x)}
            </button>
          ))}
        </div>
      )}

      {errori.map((e) => (
        <div key={e} className="ui-readwarn">
          {e}
        </div>
      ))}
      {/* ⚠️ Un campione spacciato per totale e' peggio di nessun numero: se il tetto e' stato toccato
          lo si dice, e i numeri qui sotto vanno letti come «almeno». */}
      {audit.troncato && <div className="ui-readwarn">{t('accessi.troncato')}</div>}

      {/* I numeri: a sinistra quelli che possono chiedere un intervento, e prendono colore; a destra
          il contesto che serve a leggerli. Due card e non una fila di dieci numeri uguali, che non ha
          una prima cosa da guardare. */}
      <div className="ui-hero">
        <Card titolo={t('accessi.kpi.daGuardare')}>
          <div className="ui-stats" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
            {[
              ['accessi.kpi.falliteN', audit.loginFallite ?? 0, 'crit'],
              ['accessi.kpi.dbNegate', audit.sessioniDbNegate ?? 0, 'crit'],
              ['accessi.kpi.sshAperte', audit.sshAperte ?? 0, 'crit'],
              ['accessi.kpi.scritture', audit.scritture ?? 0, 'warn'],
              // Colorato solo quando il confronto è possibile: un numero arancione che non si può
              // tradurre in «chi» è un allarme che si impara a ignorare.
              ['accessi.kpi.versioni', versioniInGiro, versioniInGiro > 1 && riferimento.fonte === 'config' ? 'warn' : null],
              ['accessi.kpi.tool', battito.conToolMancanti ?? 0, 'warn'],
            ].map(([k, n, livello]) => (
              <div key={k} className="ui-stat">
                <b className={n > 0 && livello && !(k === 'accessi.kpi.versioni' && n <= 1) ? `ui-t-${livello}` : undefined}>{n}</b>
                <span>{t(k)}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card titolo={t('accessi.kpi.contesto')} nota={finestraDetta}>
          <div className="ui-stats">
            {[
              ['accessi.kpi.persone', audit.persone?.length ?? 0],
              ['accessi.kpi.sessioni', audit.sessioniDb ?? 0],
              ['accessi.kpi.query', audit.query ?? 0],
              ['accessi.kpi.macchine', battito.macchine?.length ?? 0],
            ].map(([k, n]) => (
              <div key={k} className="ui-stat">
                <b className="ui-mute">{n}</b>
                <span>{t(k)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
      {sintesi.tranquillo.length > 0 && (
        <p className="ui-note" style={{ borderTop: 0, paddingTop: 0 }}>
          {t('accessi.sintesi.aPosto')}{' '}
          {sintesi.tranquillo
            .map((x) => (x.k === 'versioni' ? t('accessi.sintesi.zero.versioni', { n: x.n }) : t(`accessi.sintesi.zero.${x.k}`)))
            .join(' · ')}
        </p>
      )}

      {/* Le schede: una vista per volta, e il numero dice dove guardare prima di aprirla (le righe da
          guardare, o il totale quando non ce n'e'). */}
      <Tabs
        voci={viste.map((x) => ({ key: x.value, label: x.label, n: quantiGuasti(x) || quanteRighe(x) }))}
        attiva={attiva.value}
        onCambia={scegliVista}
      />

      {/* La finestra vale per l'AUDIT del cluster, non per l'heartbeat, che è per definizione
          «l'ultima riga di ogni macchina» su sette giorni: sulla vista dev-env cambiarla non muoverebbe
          una riga, e un comando che non risponde si legge come rotto. Quindi lì non c'è. */}
      <div className="ui-filtri">
        {attiva.value !== 'devEnv' && <Finestra ore={ore} gradini={gradini} onChange={setOre} t={t} />}
        <label>
          <input type="checkbox" checked={soloProblemi} onChange={(e) => setSoloProblemi(e.target.checked)} />
          {t('accessi.onlyProblems')}
        </label>
        <input
          type="search"
          className="ui-campo"
          placeholder={t('accessi.search')}
          aria-label={t('accessi.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {/* Il motivo piu' comune dei rifiuti sta DOVE si agisce, sulla vista di chi entra: e' la riga che
          dice se fuori c'e' una persona o tutto il team. */}
      {attiva.value === 'chi' && audit.motivoPiuComune && (
        <Rimedio
          livello="crit"
          titolo={t('accessi.motivoComune', { n: audit.motivoPiuComune.quante, motivo: audit.motivoPiuComune.motivo })}
          testo={t('accessi.motivoComuneCosa')}
          t={t}
        />
      )}

      {/* Una sezione per lista: le viste che ne hanno due le mostrano una sotto l'altra, invece di
          chiedere un altro clic per una domanda che e' la stessa. */}
      {mostrate.map((tb) => (
        <Sezione key={tb.titolo} titolo={tb.titolo} sotto={tb.finestra}>
          <Lista
            colonne={tb.colonne}
            griglia={tb.griglia}
            vuoto={filtrato && tb.righe.length ? t('accessi.nessunRisultato') : tb.vuoto}
          >
            {tb.filtrate.map((r) => {
              const male = tb.problema(r)
              return (
                <div key={tb.rowKey(r)} className="ui-row">
                  {!tb.senzaStato && (
                    <Pill livello={male ? tb.livello : 'ok'}>{male ? t('accessi.pill.guarda') : t('accessi.pill.ok')}</Pill>
                  )}
                  {tb.celle(r)}
                </div>
              )
            })}
          </Lista>
          {tb.nota && tb.filtrate.length > 0 && <p className="ui-note" style={{ borderTop: 0 }}>{tb.nota}</p>}
        </Sezione>
      ))}

      {/* ⚠️ Read-only per costruzione: le azioni stanno nella Web UI di Teleport, che ha l'audit e il
          replay. Qui c'e' il link, e la frase che dice perche'. */}
      {dati.webUrl && (
        <Sezione titolo={t('accessi.altrove')} sotto={t('accessi.doveSiAgisce')}>
          <ListaLink link={[{ label: t('accessi.vaiTeleport'), href: dati.webUrl, nota: t('accessi.vaiTeleportNota') }]} />
        </Sezione>
      )}
    </div>
  )
}
