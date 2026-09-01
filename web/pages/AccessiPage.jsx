import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Alert, Typography, Table, Tag, Space, Skeleton, Button, Segmented, Switch, Input, Tooltip } from 'antd'
import { PageIntro, Toolbar, Section, HeroRow, HeroStat, EmptyState } from './pageKit.jsx'
import { usePoll } from '../usePoll.js'
import PollStatus from '../components/PollStatus.jsx'
import { fmtAgo, fmtMs } from '../format.js'
import { LEVEL, SPACE, FONT } from '../theme.js'
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

const { Text } = Typography

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

const FINESTRE = (lang) => [
  { label: '24h', value: 24 },
  { label: '48h', value: 48 },
  { label: lang === 'it' ? '7g' : '7d', value: 168 },
]

// Un conteggio che parla solo quando non è zero. Lo zero dentro un `Tag` pesa come il cinque: su una
// colonna dove quasi ogni cella è zero i tag diventano una texture, e la cella che conta si perde.
function Conta({ n, level = 'warn' }) {
  return n > 0 ? (
    <Tag color={LEVEL[level].tag} style={{ marginInlineEnd: 0 }}>
      {n}
    </Tag>
  ) : (
    <Text type="secondary">0</Text>
  )
}

// «3m fa» in chiaro, il timestamp intero nel tooltip. Quattro tabelle con `31/08/2026, 15:07:09` in
// ogni riga sono quattro colonne di rumore per rispondere a una domanda che è sempre relativa.
function Quando({ ts, t, lang }) {
  if (!ts) return <Text type="secondary">—</Text>
  return (
    <Tooltip title={new Date(ts).toLocaleString(lang === 'it' ? 'it-IT' : 'en-GB')}>
      <span style={{ whiteSpace: 'nowrap' }}>{fmtAgo(ts, t)}</span>
    </Tooltip>
  )
}

// La data in chiaro, senza l'ora: per «quando e' stata costruita quest'immagine» il minuto non serve,
// e una data assoluta e' quello che si chiede quando si vuole sapere se la golden image e' stata
// aggiornata (il relativo, «8g fa», risponde a un'altra domanda e la pagina lo dice a parte).
const dataCorta = (ts, lang) => new Date(ts).toLocaleDateString(lang === 'it' ? 'it-IT' : 'en-GB')

// I comparatori delle colonne: servono ad antd per il riordino a mano, e non sono regole della pagina
// (quelle stanno in `web/accessi.js`, provate).
const numerico = (campo) => (a, b) => (a[campo] ?? 0) - (b[campo] ?? 0)
// Ordina su QUANTI ne ha, non sul campo: le colonne della mappa contengono liste (team, ruoli,
// permessi), e `numerico` su un array le confronterebbe tutte uguali a zero.
const quanti = (campo) => (a, b) => (a[campo]?.length ?? 0) - (b[campo]?.length ?? 0)
const testuale = (campo) => (a, b) => String(a[campo] ?? '').localeCompare(String(b[campo] ?? ''))

// Un nome che porta al suo audit in Teleport, quando la config dice come. Senza modello resta testo:
// la pagina promette che le sessioni si rivedono, e un link che non porta da nessuna parte è peggio
// della promessa non mantenuta.
function Nome({ href, children }) {
  if (!href) return <span>{children}</span>
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
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
  const [ore, setOre] = useState(24)
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

  if (errore && !dati) return <Alert type="error" showIcon message={String(errore)} />
  if (loading || !dati) return <Skeleton active />

  // Senza la sezione `teleport:` nella config non si mostra un vuoto che sembra un guasto: si dice
  // cosa manca. È la stessa scelta del resto dell'app (nessun nome di risorsa cablato nel codice).
  // ⚠️ `description`, non `title`: `EmptyState` prende `description`, e con la prop sbagliata questo
  // riquadro usciva senza una parola dentro, cioè un vuoto muto proprio nel caso che esiste per
  // spiegare un vuoto.
  if (!dati.configurato) {
    return (
      <>
        <PageIntro title={t('accessi.title')} desc={t('accessi.desc')} />
        <EmptyState description={t('accessi.nonConfigurato')} />
      </>
    )
  }

  const colonnePersone = [
    {
      title: t('accessi.col.persona'),
      dataIndex: 'utente',
      key: 'utente',
      sorter: testuale('utente'),
      render: (v) => <Nome href={linkAudit(dati.auditUserUrl, 'utente', v)}>{v}</Nome>,
    },
    // Le fallite E le riuscite: la prima stesura mostrava un tag solo, quindi chi aveva otto login
    // buone e due fallite risultava «2 fallite» e sembrava fuori, mentre stava lavorando.
    {
      title: t('accessi.col.login'),
      key: 'login',
      sorter: numerico('loginFallite'),
      render: (_, r) => (
        <Space size={SPACE.xs}>
          <Text type={r.loginOk ? undefined : 'secondary'}>{r.loginOk}</Text>
          {r.loginFallite > 0 && (
            <Tag color={LEVEL.crit.tag} style={{ marginInlineEnd: 0 }}>
              {t('accessi.falliteN', { n: r.loginFallite })}
            </Tag>
          )}
          {/* Quanto è durata la raffica. Tre fallite in due minuti sono un guasto in corso, tre in un
              giorno sono tre giornate diverse: il conteggio da solo le racconta identiche, ed è la
              differenza fra «ha sbagliato la password» e «da nove minuti nessuno entra». */}
          {durataFallite(r) && (
            <Text type="secondary" style={{ fontSize: FONT.micro, whiteSpace: 'nowrap' }}>
              {t('accessi.inTempo', { durata: fmtMs(durataFallite(r)) })}
            </Text>
          )}
        </Space>
      ),
    },
    // ⚠️ Le sessioni riuscite e i tentativi RIFIUTATI nella stessa cella, ma separati: sommarli e' il
    // modo in cui un accesso negato sparisce (era cosi' fino al 01/09/2026, e sette rifiuti in un
    // giorno non si vedevano da nessuna parte). Il tag rosso c'e' solo quando ce n'e' almeno uno.
    {
      title: t('accessi.col.sessioniDb'),
      key: 'sessioniDb',
      sorter: numerico('sessioniDb'),
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Space size={SPACE.xs}>
            <Text type={r.sessioniDb ? undefined : 'secondary'}>{r.sessioniDb ?? 0}</Text>
            {r.sessioniDbNegate > 0 && (
              <Tag color={LEVEL.crit.tag} style={{ marginInlineEnd: 0 }}>
                {t('accessi.dbNegateN', { n: r.sessioniDbNegate })}
              </Tag>
            )}
          </Space>
          {/* COSA ha chiesto, non solo quante volte: il rimedio sta nella coppia utente+database, e il
              conteggio da solo la nasconde. Dietro i quattordici rifiuti del 01/09/2026 c'erano tre
              problemi diversi (`dev_readwrite` chiesto al tunnel di sola lettura, il proprio nome dove
              l'utente e' uno solo, `postgres` dove non si concede mai), e da «14 accessi negati» non se
              ne ricavava nessuno. Si mostrano TUTTE le coppie: sono una o due, e un «+2» nascosto
              rimanda a un'altra pagina proprio la persona che ha fretta. */}
          {(r.negati ?? []).map((n) => (
            <Text
              key={`${n.dbUser}/${n.servizio}/${n.nome}`}
              type="secondary"
              style={{ fontSize: FONT.micro, whiteSpace: 'nowrap' }}
            >
              {t('accessi.negatoCombo', { n: n.quante, dbUser: n.dbUser, db: n.nome, servizio: n.servizio })}
            </Text>
          ))}
        </Space>
      ),
    },
    { title: t('accessi.col.query'), dataIndex: 'query', key: 'query', sorter: numerico('query') },
    // Le scritture in arancione: su un database di produzione sono la riga che si guarda per prima.
    {
      title: t('accessi.col.scritture'),
      dataIndex: 'scritture',
      key: 'scritture',
      sorter: numerico('scritture'),
      render: (n) => <Conta n={n} />,
    },
    // Il motivo per intero, non troncato: è la riga che distingue «sessione scaduta» da «ruolo che non
    // esiste», cioè una persona sola da tutto il team fuori.
    {
      title: t('accessi.col.motivo'),
      dataIndex: 'motivo',
      key: 'motivo',
      render: (v) => (v ? <Text style={{ fontSize: FONT.small }}>{v}</Text> : <Text type="secondary">—</Text>),
    },
    {
      title: t('accessi.col.ultima'),
      dataIndex: 'ultima',
      key: 'ultima',
      sorter: numerico('ultima'),
      render: (v) => <Quando ts={v} t={t} lang={lang} />,
    },
  ]

  const colonneDatabase = [
    // Un `?` in colonna è il nome che il log non aveva (Redis non manda `db_name`): si scrive «—», che
    // è la stessa informazione senza sembrare un errore di lettura.
    {
      title: t('accessi.col.database'),
      dataIndex: 'nome',
      key: 'nome',
      sorter: testuale('nome'),
      render: (v) => (v && v !== '?' ? v : <Text type="secondary">—</Text>),
    },
    { title: t('accessi.col.servizio'), dataIndex: 'servizio', key: 'servizio', sorter: testuale('servizio') },
    {
      title: t('accessi.col.ambiente'),
      dataIndex: 'ambiente',
      key: 'ambiente',
      sorter: testuale('ambiente'),
      render: (v) =>
        v === 'prod' ? (
          <Tag color={LEVEL.crit.tag} style={{ marginInlineEnd: 0 }}>
            {v}
          </Tag>
        ) : v ? (
          <Tag style={{ marginInlineEnd: 0 }}>{v}</Tag>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    { title: t('accessi.col.query'), dataIndex: 'query', key: 'query', sorter: numerico('query') },
    {
      title: t('accessi.col.scritture'),
      dataIndex: 'scritture',
      key: 'scritture',
      sorter: numerico('scritture'),
      render: (n, r) => <Conta n={n} level={r.ambiente === 'prod' ? 'crit' : 'warn'} />,
    },
    { title: t('accessi.col.quantePersone'), dataIndex: 'persone', key: 'persone', sorter: numerico('persone') },
  ]

  const colonneMacchine = [
    {
      title: t('accessi.col.macchina'),
      dataIndex: 'macchina',
      key: 'macchina',
      sorter: testuale('macchina'),
      render: (v, r) => (
        <Space size={SPACE.xs}>
          <Nome href={linkAudit(dati.auditNodeUrl, 'macchina', v)}>{v}</Nome>
          {/* L'esito dell'avvio compare SOLO quando non è `ok`: una colonna che dice «ok» su ogni riga
              è una colonna che nessuno legge, e il giorno che dice altro nessuno la nota. */}
          {avvioStorto(r) && (
            <Tag color={LEVEL.warn.tag} style={{ marginInlineEnd: 0 }}>
              {t('accessi.esitoNonOk', { esito: r.esito })}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: t('accessi.col.lato'),
      dataIndex: 'lato',
      key: 'lato',
      sorter: testuale('lato'),
      render: (v) => (v ? <Text type="secondary">{v}</Text> : <Text type="secondary">—</Text>),
    },
    {
      title: t('accessi.col.persona'),
      dataIndex: 'utente',
      key: 'utente',
      sorter: testuale('utente'),
      // Fra i nomi con cui la stessa persona è comparsa si mostra quello che Teleport conosce, e gli
      // altri stanno nel tooltip: senza questa scelta la stessa persona sembrava due.
      render: (_, r) => {
        const { nome, altri } = personaMacchina(r, utentiNoti)
        if (!nome) return <Text type="secondary">—</Text>
        const link = linkAudit(dati.auditUserUrl, 'utente', nome)
        const dentro = <Nome href={link}>{nome}</Nome>
        return altri.length ? <Tooltip title={t('accessi.altriNomi', { nomi: altri.join(', ') })}>{dentro}</Tooltip> : dentro
      },
    },
    // Il digest corto + «indietro»: è la mezza riga che risponde alla seconda domanda della pagina.
    // Prima qui c'erano cinque hash troncati tutti uguali nei primi sette caratteri, e capire chi fosse
    // rimasto indietro voleva dire copiarli fuori e confrontarli a mano.
    {
      title: (
        <Tooltip title={riferimento.fonte === 'config' ? t('accessi.imgAttesa') : t('accessi.imgRiferimento')}>
          <span style={{ borderBottom: '1px dotted currentColor' }}>{t('accessi.col.immagine')}</span>
        </Tooltip>
      ),
      dataIndex: 'immagine',
      key: 'immagine',
      sorter: testuale('immagine'),
      render: (v, r) => (
        <Space direction="vertical" size={0}>
          <Space size={SPACE.xs}>
          {/* Tre stati diversi, e prima erano due. «Non dichiarata» non è una versione vecchia: è una
              riga in cui l'avvio non ha potuto leggere l'immagine, e mostrarla come un digest a metà
              la faceva sembrare una versione (e contare fra quelle «in giro»). */}
          {senzaVersione(r) ? (
            <Text type="secondary">{t('accessi.img.nonDichiarata')}</Text>
          ) : (
            <Text code copyable={{ text: v }}>
              {digestCorto(v)}
            </Text>
          )}
          {/* ⚠️ «Indietro» è un'accusa e si fa solo con la versione attesa dalla config. Col ripiego si
              dice «diversa», in grigio: il riferimento sarebbe la più recente AVVIATA, che si elegge
              con l'orologio, e il 31/08/2026 marcava indietro quattro macchine su cinque, fra cui una
              che aveva l'immagine più nuova di quella eletta. */}
          {indietro(r) ? (
            <Tag color={LEVEL.warn.tag} style={{ marginInlineEnd: 0 }}>
              {quantoIndietro(r) != null
                ? frase('accessi.img.indietroGiorni', quantoIndietro(r))
                : t('accessi.img.indietro')}
            </Tag>
          ) : null}
          </Space>
          {/* QUANDO e' stata costruita l'immagine che ha in mano. Il digest non ha un ordine e «indietro
              di 8 giorni» lo dice il tag solo quando c'e' un riferimento: senza la data in chiaro, chi
              guarda una riga sola non sa se la sua immagine e' di ieri o di marzo. */}
          {dataImmagine(r) != null && (
            <Text type="secondary" style={{ fontSize: FONT.micro, whiteSpace: 'nowrap' }}>
              {t('accessi.img.del', { data: dataCorta(dataImmagine(r), lang) })}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: t('accessi.col.tool'),
      dataIndex: 'toolMancanti',
      key: 'tool',
      sorter: numerico('toolMancanti'),
      render: (n) => <Conta n={n} />,
    },
    // Quando + quanto ci ha messo, nella stessa cella: la durata è un dato che il server manda da
    // sempre e che la pagina buttava via, e «il dev-env qui parte in quattro minuti» è metà dei «a me
    // non funziona». Una colonna in più per un numero che si guarda di rado non se la merita.
    {
      title: t('accessi.col.ultimoAvvio'),
      dataIndex: 'quando',
      key: 'quando',
      sorter: numerico('quando'),
      render: (v, r) => (
        <Space size={SPACE.xs}>
          <Quando ts={v} t={t} lang={lang} />
          {r.durata != null && (
            <Text type="secondary" style={{ fontSize: FONT.micro, whiteSpace: 'nowrap' }}>
              {t('accessi.avviatoIn', { durata: fmtMs(r.durata * 1000) })}
            </Text>
          )}
        </Space>
      ),
    },
    // Il comando per entrare, copiabile. Il MODELLO arriva dalla config (`teleport.sshCommand`, con
    // `{macchina}` dentro) e non dal codice: qui non stanno i nomi degli strumenti di nessuno, come
    // per log group e account. Senza quel campo la colonna non c'è, invece di mostrare un comando
    // inventato che non esiste su nessuna macchina.
    // ⚠️ Solo per `lato: host`: il container non è una macchina raggiungibile, e un comando che non
    // funziona è peggio che nessun comando.
    ...(dati.sshCommand
      ? [
          {
            title: t('accessi.col.comeEntri'),
            key: 'comeEntri',
            render: (_, r) =>
              r.lato === 'host' ? (
                <Text code copyable>
                  {dati.sshCommand.replace('{macchina}', r.macchina)}
                </Text>
              ) : (
                <Text type="secondary">—</Text>
              ),
          },
        ]
      : []),
  ]

  // Chi è entrato sulle macchine: la metà che l'heartbeat non copre. L'heartbeat dice chi è rimasto
  // indietro, questa dice chi è andato a vedere, ed è la traccia che rende accettabile il primo.
  const colonneSsh = [
    {
      title: t('accessi.col.macchina'),
      dataIndex: 'macchina',
      key: 'macchina',
      sorter: testuale('macchina'),
      render: (v) => <Nome href={linkAudit(dati.auditNodeUrl, 'macchina', v)}>{v}</Nome>,
    },
    {
      title: t('accessi.col.chiEntrato'),
      dataIndex: 'chi',
      key: 'chi',
      render: (v) => (v?.length ? v.join(', ') : <Text type="secondary">—</Text>),
    },
    { title: t('accessi.col.quanteSessioni'), dataIndex: 'sessioni', key: 'sessioni', sorter: numerico('sessioni') },
    // Le aperte in rosso: qualcuno è dentro adesso, ed è la riga a cui si reagisce subito.
    {
      title: t('accessi.col.aperte'),
      dataIndex: 'aperte',
      key: 'aperte',
      sorter: numerico('aperte'),
      render: (n) => <Conta n={n} level="crit" />,
    },
    {
      title: t('accessi.col.ultima'),
      dataIndex: 'ultima',
      key: 'ultima',
      sorter: numerico('ultima'),
      render: (v) => <Quando ts={v} t={t} lang={lang} />,
    },
  ]

  // ⚠️ QUESTE STANNO PRIMA di `viste`, e non e' una questione di stile: l'array `viste` viene
  // valutato subito e legge `finestraDetta`. Dichiararlo piu' sotto lo fa cadere nella zona morta
  // temporale del `const`, cioe' `ReferenceError: Cannot access '…' before initialization` a ogni
  // render. E' successo il 31/08/2026 ed e' arrivato in produzione: il bundler non lo vede (non e'
  // un errore di sintassi) e i test nemmeno, perche' qui nessuna prova RENDERIZZA un componente.
  // I segnali che valgono per TUTTA la pagina, contati una volta: decidono se la riga verde «tutto
  // tranquillo» ha il diritto di esserci. Un riepilogo che tace quando va tutto bene lascia chi guarda
  // a chiedersi se la pagina ha caricato.
  const quante = daGuardare(audit, battito, riferimento)
  const sintesi = riepilogo(audit, battito, riferimento)
  // ⚠️ «1 macchine» e «1 login fallite» sono la prima cosa che si nota in una riga che deve leggersi in
  // un colpo d'occhio. Il dizionario non ha i plurali: ogni frase ha la sua forma per UNO, e si scegle
  // qui in base al numero.
  const frase = (chiave, n, extra = {}) => t(n === 1 ? `${chiave}.uno` : chiave, { n, ...extra })
  // La finestra del DATO, non quella chiesta: quando il server sta ancora rileggendo (sette giorni di
  // log non sono istantanei) i numeri sono ancora quelli di prima, e va detto invece di lasciare
  // l'interruttore su «7g» sopra dei numeri di 24 ore.
  const finestraDetta =
    audit.ore && audit.ore !== ore
      ? `${t('accessi.ultimeOre', { n: audit.ore })} · ${t('accessi.inAggiornamento')}`
      : t('accessi.ultimeOre', { n: audit.ore ?? ore })
  const nessunoAggiornato = tuttiIndietro(battito.macchine ?? [], riferimento)

  // Le quattro tabelle come DATI, non come quattro blocchi copiati: l'interruttore, il conteggio, il
  // pallino, il filtro e la ricerca si scrivono una volta e valgono per tutte.
  // ── La mappa: una riga per persona, una per team ────────────────────────────────────────────────
  // I permessi del portale si mostrano RAGGRUPPATI per account e non uno per uno: con cinque
  // permission set su due account la cella diventa una lista, e la domanda («quanto puo' fare qui
  // dentro?») si risponde col numero, mentre i nomi stanno nel tooltip di chi li vuole.
  const perAccount = (permessi = []) => {
    const m = new Map()
    for (const p of permessi) m.set(p.account, [...(m.get(p.account) ?? []), p.permissionSet])
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }
  // Tanti tag uguali sono rumore: sopra i tre si mostra il conteggio e i nomi vanno nel tooltip.
  const elencoCorto = (valori = [], vuoto = null) => {
    if (!valori.length) return vuoto
    if (valori.length <= 3)
      return (
        <Space size={SPACE.xs} wrap>
          {valori.map((v) => (
            <Tag key={v} style={{ marginInlineEnd: 0 }}>
              {v}
            </Tag>
          ))}
        </Space>
      )
    return (
      <Tooltip title={valori.join(' · ')}>
        <Tag style={{ marginInlineEnd: 0 }}>{t('accessi.mappa.quanti', { n: valori.length })}</Tag>
      </Tooltip>
    )
  }

  // Cosa ha risposto e cosa no. Serve perche' una fonte muta si legge come «questa persona non ha
  // niente»: il parametro con la mappa dei team che manca, o Identity Center non leggibile, devono
  // dirsi in pagina, non restare un vuoto che sembra un fatto.
  const fonti = mappa?.fonti ?? {}
  const notaFonti = [
    fonti.ruoli?.assente ? t('accessi.mappa.senzaMappa', { param: fonti.ruoli.assente }) : null,
    fonti.ruoli?.errore ? t('accessi.mappa.fonteRotta', { fonte: 'SSM', motivo: fonti.ruoli.errore }) : null,
    fonti.sso?.errore ? t('accessi.mappa.fonteRotta', { fonte: 'Identity Center', motivo: fonti.sso.errore }) : null,
    fonti.teleport?.errore ? t('accessi.mappa.fonteRotta', { fonte: 'Teleport', motivo: fonti.teleport.errore }) : null,
    mappaErrore ? String(mappaErrore) : null,
  ]
    .filter(Boolean)
    .join(' · ') || null

  const colonneMappa = [
    {
      title: t('accessi.col.persona'),
      dataIndex: 'persona',
      key: 'persona',
      sorter: testuale('persona'),
      render: (v, r) => (
        <Space size={SPACE.xs}>
          <Nome href={linkAudit(dati.auditUserUrl, 'utente', v)}>{v}</Nome>
          {/* Chi non entra su Teleport non e' senza accessi: ha quelli del portale, e questa e' la
              riga da guardare quando ci si chiede a chi e' rimasto addosso un permesso. */}
          {r.soloSso && <Tag style={{ marginInlineEnd: 0 }}>{t('accessi.mappa.soloPortale')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('accessi.mappa.col.team'),
      key: 'team',
      sorter: quanti('teams'),
      render: (_, r) =>
        r.teamsNoti
          ? elencoCorto(r.teams, <Text type="secondary">{t('accessi.mappa.nessunTeam')}</Text>)
          : <Text type="secondary">{t('accessi.mappa.senzaLogin')}</Text>,
    },
    {
      title: t('accessi.mappa.col.ruoli'),
      key: 'ruoli',
      sorter: quanti('ruoli'),
      render: (_, r) => (
        <Space size={SPACE.xs} wrap>
          {r.ruoli.length ? (
            <Tooltip title={r.ruoli.join(' · ')}>
              <Tag color={LEVEL.ok.tag} style={{ marginInlineEnd: 0 }}>
                {t('accessi.mappa.quanti', { n: r.ruoli.length })}
              </Tag>
            </Tooltip>
          ) : (
            <Text type="secondary">0</Text>
          )}
          {/* Un team che la mappa non nomina non concede niente su Teleport: di norma e' un team dei
              repository, e senza questa nota la riga sembra una mappa incompleta. */}
          {r.teamsSenzaRuoli?.length > 0 && (
            <Tooltip title={r.teamsSenzaRuoli.join(' · ')}>
              <Text type="secondary" style={{ fontSize: FONT.micro }}>
                {t('accessi.mappa.soloRepoN', { n: r.teamsSenzaRuoli.length })}
              </Text>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: t('accessi.mappa.col.portale'),
      key: 'portale',
      sorter: quanti('permessi'),
      render: (_, r) =>
        r.permessi.length ? (
          <Space size={SPACE.xs} wrap>
            {perAccount(r.permessi).map(([account, ps]) => (
              <Tooltip key={account} title={ps.join(' · ')}>
                <Tag style={{ marginInlineEnd: 0 }}>{`${account} · ${ps.length}`}</Tag>
              </Tooltip>
            ))}
          </Space>
        ) : (
          <Text type="secondary">{t('accessi.mappa.nessunPortale')}</Text>
        ),
    },
    {
      title: t('accessi.mappa.col.ultimoLogin'),
      key: 'ultimoLogin',
      sorter: numerico('ultimoLogin'),
      render: (_, r) =>
        r.ultimoLogin ? (
          <Tooltip title={new Date(r.ultimoLogin).toLocaleString()}>
            <Text type="secondary">{fmtAgo(r.ultimoLogin)}</Text>
          </Tooltip>
        ) : (
          <Text type="secondary">{t('accessi.mappa.mai')}</Text>
        ),
    },
  ]

  const colonneTeam = [
    {
      title: t('accessi.mappa.col.teamNome'),
      dataIndex: 'team',
      key: 'team',
      sorter: testuale('team'),
      render: (v, r) => (
        <Space size={SPACE.xs}>
          <Text strong>{v}</Text>
          {r.soloRepo && <Tag style={{ marginInlineEnd: 0 }}>{t('accessi.mappa.soloRepo')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('accessi.mappa.col.ruoli'),
      key: 'ruoli',
      sorter: quanti('ruoli'),
      render: (_, r) => elencoCorto(r.ruoli, <Text type="secondary">0</Text>),
    },
    {
      title: t('accessi.mappa.col.membri'),
      key: 'membri',
      sorter: quanti('membri'),
      render: (_, r) => elencoCorto(r.membri, <Text type="secondary">{t('accessi.mappa.nessunMembro')}</Text>),
    },
  ]

  // ── Le TABELLE, e poi le viste che le raccolgono ──────────────────────────────────────────────
  //
  // Prima erano sei tabelle e sei interruttori, in fila: per sapere com'era andata la giornata si
  // aprivano tutti e sei, e nessuno dei sei diceva se negli altri cinque ci fosse qualcosa. Le domande
  // pero' sono quattro, non sei: «chi entra» e' la stessa domanda per le login e per le sessioni sulle
  // macchine, «chi ha cosa» la stessa per le persone e per i team. Quindi una vista puo' avere piu'
  // tabelle, l'interruttore conta e segnala per tutte quelle che ha dentro, e il filtro le attraversa.
  //
  // L'ORDINE e' quello dell'urgenza, non quello in cui sono state scritte: prima chi non riesce a
  // entrare o ha sbattuto contro un permesso, poi cosa si sta toccando sui database, poi chi ha il
  // dev-env indietro, e in fondo gli elenchi da consultare, che non hanno mai una riga rotta.
  const tabellaPersone = {
    titolo: t('accessi.persone'),
    righe: persone,
    colonne: colonnePersone,
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
    colonne: colonneSsh,
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
    colonne: colonneDatabase,
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
    colonne: colonneMacchine,
    rowKey: (r) => `${r.macchina}/${r.lato}`,
    problema: (m) => problemaMacchina(m, riferimento, dataRif),
    livello: 'warn',
    cerca: (m) => [m.macchina, m.utente, m.immagine],
    vuoto: t('accessi.nessunAvvio'),
    // ⚠️ La data della GOLDEN IMAGE, in chiaro e non solo come «indietro di N giorni». La pagina
    // sapeva gia' confrontare le immagini fra loro, ma non diceva da quando esiste quella buona:
    // chi apre questa vista chiede prima di tutto «l'immagine e' stata aggiornata?», e un elenco di
    // digest non risponde. Se nessun avvio manda la data si dice quello, invece di lasciare il buco.
    nota:
      dataRif != null
        ? t('accessi.golden.del', {
            digest: digestCorto(riferimento.immagine) || '—',
            data: dataCorta(dataRif, lang),
            quando: fmtAgo(dataRif, t),
          })
        : t('accessi.golden.senzaData'),
    finestra: `${t('accessi.ultimiGiorni', { n: battito.giorni ?? 7 })} · ${
      // Su cosa si sta confrontando, detto in una riga: la versione attesa dalla config, oppure la
      // DATA dell'immagine più recente vista (che è un ordine, quindi «indietro di N giorni» è un
      // fatto), oppure niente, quando gli avvii non mandano ancora la data.
      riferimento.fonte === 'config'
        ? t('accessi.fonte.config')
        : dataRif != null
          ? t('accessi.fonte.data')
          : t('accessi.fonte.vista')
    }`,
  }

  // Le due tabelle di «chi ha cosa»: nessun pallino di allarme, e non e' una dimenticanza. Qui non
  // c'e' una riga rotta da far emergere, c'e' un elenco da consultare, ed e' la ragione per cui sta
  // in fondo e non in mezzo alle altre.
  const tabellaMappa = {
    titolo: t('accessi.mappa.persone'),
    righe: mappa?.persone ?? [],
    colonne: colonneMappa,
    rowKey: (r) => r.persona,
    problema: () => false,
    livello: 'warn',
    cerca: (r) => [r.persona, r.ssoUtente, ...(r.teams ?? []), ...(r.ruoli ?? []), ...(r.gruppiSso ?? [])],
    vuoto: t('accessi.mappa.vuoto'),
    finestra: t('accessi.mappa.finestra', { n: Math.round((mappa?.ore ?? 168) / 24) }),
    nota: notaFonti,
  }

  const tabellaTeam = {
    titolo: t('accessi.mappa.team'),
    righe: mappa?.teams ?? [],
    colonne: colonneTeam,
    rowKey: (r) => r.team,
    problema: () => false,
    livello: 'warn',
    cerca: (r) => [r.team, ...(r.ruoli ?? []), ...(r.membri ?? [])],
    vuoto: t('accessi.mappa.vuotoTeam'),
    finestra: t('accessi.mappa.finestra', { n: Math.round((mappa?.ore ?? 168) / 24) }),
    nota: notaFonti,
  }

  // I nomi delle viste sono la DOMANDA a cui rispondono, non il nome della tabella: «Persone» e
  // «SSH» dicono cosa c'e' dentro a chi gia' lo sa, e chi apre la pagina durante un guasto non lo sa.
  const viste = [
    { value: 'chi', label: t('accessi.view.chi'), tabelle: [tabellaPersone, tabellaSsh] },
    { value: 'database', label: t('accessi.view.database'), tabelle: [tabellaDatabase] },
    { value: 'devEnv', label: t('accessi.view.devEnv'), tabelle: [tabellaMacchine] },
    { value: 'chiHaCosa', label: t('accessi.view.chiHaCosa'), tabelle: [tabellaMappa, tabellaTeam] },
  ]

  const attiva = viste.find((v) => v.value === vista) ?? viste[0]
  // Il filtro e la ricerca attraversano TUTTE le tabelle della vista: una riga nascosta in una
  // tabella e mostrata nell'altra sarebbe lo stesso interruttore con due significati.
  const mostrate = attiva.tabelle.map((tb) => ({
    ...tb,
    filtrate: filtraRighe(tb.righe, { problema: tb.problema, cerca: tb.cerca, query, soloProblemi }),
  }))
  const filtrato = Boolean(query.trim()) || soloProblemi
  // Quante righe ha una vista e quante ne chiedono un intervento: il conteggio e il pallino
  // dell'interruttore valgono per tutte le sue tabelle, sennò una tabella chiusa nasconde un segnale.
  const quanteRighe = (v) => v.tabelle.reduce((n, tb) => n + tb.righe.length, 0)
  const quantiGuasti = (v) => v.tabelle.reduce((n, tb) => n + tb.righe.filter(tb.problema).length, 0)
  // Il colore del pallino: quello della tabella messa peggio fra le sue, non della prima.
  const livelloVista = (v) =>
    v.tabelle.find((tb) => tb.livello === 'crit' && tb.righe.some(tb.problema))?.livello ??
    v.tabelle.find((tb) => tb.righe.some(tb.problema))?.livello ??
    v.tabelle[0].livello


  return (
    <>
      <PageIntro
        title={t('accessi.title')}
        desc={t('accessi.desc')}
        extra={
          <Toolbar>
            <PollStatus lastUpdated={lastUpdated} refreshing={refreshing || mappaRefreshing} t={t} />
            {/* L'interruttore fra le quattro tabelle porta il conteggio e, quando dentro c'è qualcosa da
                guardare, un pallino colorato: così una tabella chiusa non nasconde un segnale, ed è la
                condizione per mostrarne una sola invece di quattro in colonna. */}
            <Segmented
              size="small"
              value={attiva.value}
              onChange={scegliVista}
              options={viste.map((v) => {
                const guasti = quantiGuasti(v)
                return {
                  value: v.value,
                  label: (
                    <span
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                      title={guasti ? t('accessi.daGuardare', { n: guasti }) : undefined}
                    >
                      {v.label}
                      <span style={{ fontSize: FONT.micro, opacity: 0.55 }}>{quanteRighe(v)}</span>
                      {guasti > 0 && (
                        <span
                          aria-label={t('accessi.daGuardare', { n: guasti })}
                          role="img"
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 3,
                            background: LEVEL[livelloVista(v)].color,
                            display: 'inline-block',
                          }}
                        />
                      )}
                    </span>
                  ),
                }
              })}
            />
            {/* La finestra vale per l'AUDIT del cluster, non per l'heartbeat, che è per definizione
                «l'ultima riga di ogni macchina» su sette giorni. Sulla vista Dev-env l'interruttore
                spariva dal lavoro pur restando in pagina: cambiarlo non muoveva una riga, e un comando
                che non risponde si legge come rotto. Quindi lì non c'è. */}
            {attiva.value !== 'devEnv' && (
              <Segmented size="small" value={ore} onChange={setOre} options={FINESTRE(lang)} />
            )}
            <Space size={SPACE.xs}>
              <Switch size="small" checked={soloProblemi} onChange={setSoloProblemi} />
              <Text style={{ fontSize: FONT.small }}>{t('accessi.onlyProblems')}</Text>
            </Space>
            <Input.Search
              allowClear
              size="small"
              placeholder={t('accessi.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ width: 190 }}
            />
          </Toolbar>
        }
      />

      {/* ⚠️ La riga che risponde a «e quindi?» prima dei numeri. Sui dati veri di una giornata normale
          i cinque numeri grandi sono tre zeri e due numeri, e per sapere cosa fossero le «6 scritture»
          bisognava aprire la tabella dei database, poi quella delle persone, e incrociarle a mano.
          Qui la pagina lo dice: cosa ha trovato, dove, e cosa ha guardato senza trovare niente. */}
      {sintesi.trovato.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: `${SPACE.xs}px ${SPACE.md}px`, marginBottom: SPACE.sm }}>
          <Text strong style={{ fontSize: FONT.lead }}>
            {t('accessi.sintesi.trovato')}
          </Text>
          {sintesi.trovato.map((v) => (
            <a
              key={v.k}
              onClick={() => scegliVista(v.vista)}
              style={{ fontSize: FONT.lead, cursor: 'pointer' }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && scegliVista(v.vista)}
            >
              {v.k === 'indietro'
                ? frase('accessi.sintesi.indietro', v.n, { g: v.giorni })
                : v.k === 'scritture'
                  ? frase(v.prod ? 'accessi.sintesi.scrittureProd' : 'accessi.sintesi.scritture', v.n, {
                      dove: v.dove.join(', '),
                    }) + (v.altrove > 0 ? ` ${frase('accessi.sintesi.altrove', v.altrove)}` : '')
                  : v.k === 'versioni'
                    ? t(v.tutti ? 'accessi.sintesi.versioniTutti' : 'accessi.sintesi.versioni', { n: v.n })
                    : frase(`accessi.sintesi.${v.k}`, v.n)}
            </a>
          ))}
        </div>
      )}
      {sintesi.tranquillo.length > 0 && (
        <Text type="secondary" style={{ display: 'block', fontSize: FONT.small, marginBottom: SPACE.lg }}>
          {t('accessi.sintesi.aPosto')}{' '}
          {sintesi.tranquillo
            .map((v) =>
              v.k === 'versioni'
                ? t('accessi.sintesi.zero.versioni', { n: v.n })
                : t(`accessi.sintesi.zero.${v.k}`),
            )
            .join(' · ')}
        </Text>
      )}

      {/* La riga dei numeri: si guarda per prima e risponde a «serve che io faccia qualcosa?». I cinque
          che possono chiedere un intervento stanno grandi e prendono colore; gli altri quattro sono il
          contesto che serve a leggerli, e stanno più piccoli. Prima erano nove tutti uguali, e una fila
          di nove numeri identici non ha una prima cosa da guardare. */}
      <HeroRow>
        <HeroStat
          label={t('accessi.kpi.falliteN')}
          value={audit.loginFallite ?? 0}
          color={audit.loginFallite ? LEVEL.crit.color : undefined}
        />
        {/* Gli accessi ai database NEGATI: un numero a se', accanto alle login fallite, perche' sono
            la stessa domanda («chi ha sbattuto contro un permesso?») e prima non erano da nessuna
            parte, sommati alle sessioni riuscite. */}
        <HeroStat
          label={t('accessi.kpi.dbNegate')}
          value={audit.sessioniDbNegate ?? 0}
          color={audit.sessioniDbNegate ? LEVEL.crit.color : undefined}
        />
        {/* Le sessioni SSH APERTE sono un numero a sé, e non il colore rosso appiccicato al totale:
            «Sessioni SSH 2» tinto di rosso si legge come «2 aperte adesso» anche quando sono chiuse
            entrambe, che è la cosa sbagliata da capire su un accesso a una macchina di qualcuno. */}
        <HeroStat
          label={t('accessi.kpi.sshAperte')}
          value={audit.sshAperte ?? 0}
          color={audit.sshAperte ? LEVEL.crit.color : undefined}
        />
        <HeroStat
          label={t('accessi.kpi.scritture')}
          value={audit.scritture ?? 0}
          color={audit.scritture ? LEVEL.warn.color : undefined}
        />
        {/* Colorato solo quando il confronto è possibile: un numero arancione che non si può tradurre
            in «chi» è un allarme che si impara a ignorare. */}
        <HeroStat
          label={t('accessi.kpi.versioni')}
          value={versioniInGiro}
          color={versioniInGiro > 1 && riferimento.fonte === 'config' ? LEVEL.warn.color : undefined}
        />
        <HeroStat
          label={t('accessi.kpi.tool')}
          value={battito.conToolMancanti ?? 0}
          color={battito.conToolMancanti ? LEVEL.warn.color : undefined}
        />
        {/* Il taglio fra i cinque numeri che possono chiedere un intervento e i quattro che servono a
            leggerli. Senza, la fila è una sola riga di nove numeri larga tutta la pagina, e la
            differenza di corpo da sola non basta a dire dove finisce una cosa e comincia l'altra. */}
        <span aria-hidden="true" style={{ alignSelf: 'stretch', borderInlineStart: '1px solid var(--dg-line)' }} />
        <HeroStat label={t('accessi.kpi.persone')} value={audit.persone?.length ?? 0} size={18} />
        <HeroStat label={t('accessi.kpi.sessioni')} value={audit.sessioniDb ?? 0} size={18} />
        {/* ⚠️ Il totale delle sessioni SSH era un numero di troppo: accanto a «SESSIONI SSH APERTE» dei
            segnali si leggeva come lo stesso numero contato due volte, perché le due etichette
            differiscono per una parola. Quante macchine hanno avuto sessioni lo dice già l'interruttore
            («SSH 1»), e quante ne ha avute ciascuna la sua tabella: qui restava solo a confondere. */}
        <HeroStat label={t('accessi.kpi.query')} value={audit.query ?? 0} size={18} />
        <HeroStat label={t('accessi.kpi.macchine')} value={battito.macchine?.length ?? 0} size={18} />
      </HeroRow>

      {/* ⚠️ Un campione spacciato per totale e' peggio di nessun numero: se il tetto e' stato toccato
          lo si dice, e i numeri qui sopra vanno letti come «almeno». */}
      {audit.troncato && (
        <Alert type="info" showIcon message={t('accessi.troncato')} style={{ marginBottom: SPACE.md }} />
      )}

      {audit.errore && <Alert type="warning" showIcon message={audit.errore} style={{ marginBottom: SPACE.md }} />}
      {battito.errore && <Alert type="warning" showIcon message={battito.errore} style={{ marginBottom: SPACE.md }} />}
      {/* ⚠️ Gli avvisi che seguono stanno DOVE si agisce, non in cima a qualunque vista. Prima erano
          tutti sempre in pagina: chi apriva i database si prendeva tre righe sul dev-env prima di
          arrivare alla tabella, e il quarto avviso di fila non lo legge piu' nessuno. Restano sopra a
          tutto solo i guasti di lettura (l'audit che non risponde) e la riga verde: quelli parlano
          della pagina intera. */}
      {attiva.value === 'chi' && audit.motivoPiuComune && (
        <Alert
          type="error"
          showIcon
          message={t('accessi.motivoComune', { n: audit.motivoPiuComune.quante, motivo: audit.motivoPiuComune.motivo })}
          style={{ marginBottom: SPACE.md }}
        />
      )}
      {/* «Sono indietro TUTTI»: si può dire solo quando la versione attesa la sa la config. Col ripiego
          («la più nuova che qualcuno ha visto») questo caso è invisibile, perché se nessuno ha
          aggiornato il riferimento è la vecchia e tutti risultano pari: è il buco che questa riga
          chiude, e la ragione per cui il campo di config esiste. */}
      {attiva.value === 'devEnv' && nessunoAggiornato && (
        <Alert type="error" showIcon message={t('accessi.nessunoAggiornato')} style={{ marginBottom: SPACE.md }} />
      )}
      {/* ⚠️ Prima diceva «qualcuno è rimasto indietro» su un dato che non lo sa. Con cinque macchine e
          cinque digest diversi (dati veri del 31/08/2026) versioni diverse vuol dire solo che ognuno ha
          l'immagine che ha scaricato: chi è indietro lo si può dire solo con la versione attesa in
          config, e senza quella l'avviso lo dichiara e dice come metterla. */}
      {/* Con le DATE l'avviso dice un fatto: quante macchine sono indietro e di quanto. Senza (dev-env
          non ancora aggiornato, quindi nessuna data) resta la frase che spiega perche' da qui non si
          puo' dire, che e' l'unica cosa onesta con dei soli digest in mano. */}
      {attiva.value === 'devEnv' &&
        (dataRif != null
          ? macchineIndietro.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={t('accessi.indietroN', {
                  n: macchineIndietro.length,
                  g: Math.max(...macchineIndietro.map((m) => quantoIndietro(m) ?? 0)),
                })}
                style={{ marginBottom: SPACE.md }}
              />
            )
          : versioniInGiro > 1 && (
              <Alert
                type={riferimento.fonte === 'config' ? 'warning' : 'info'}
                showIcon
                message={
                  riferimento.fonte === 'config'
                    ? t('accessi.versioniDiverse', { n: versioniInGiro })
                    : t('accessi.versioniSenzaAttesa', { n: versioniInGiro })
                }
                style={{ marginBottom: SPACE.md }}
              />
            ))}
      {/* Le macchine che non hanno dichiarato la versione: contate a parte, perché non sono «indietro»
          e non sono «pari», e finivano dentro il conteggio delle versioni come se fossero una versione. */}
      {attiva.value === 'devEnv' && battito.senzaVersione > 0 && (
        <Alert
          type="info"
          showIcon
          message={t('accessi.senzaVersioneN', { n: battito.senzaVersione })}
          style={{ marginBottom: SPACE.md }}
        />
      )}
      {quante === 0 && !audit.errore && !battito.errore && (
        <Alert type="success" showIcon message={t('accessi.tuttoTranquillo')} style={{ marginBottom: SPACE.md }} />
      )}

      {/* Una sezione per tabella: le viste che ne hanno due le mostrano una sotto l'altra, invece di
          chiedere un altro clic per una domanda che e' la stessa. */}
      {mostrate.map((tb) => (
        <Section
          key={tb.titolo}
          title={tb.titolo}
          aside={
            <Text type="secondary" style={{ fontSize: FONT.small }}>
              {tb.finestra}
            </Text>
          }
        >
          <Table
            size="small"
            className="dg-sticky"
            rowKey={tb.rowKey}
            pagination={false}
            columns={tb.colonne}
            dataSource={tb.filtrate}
            locale={{ emptyText: filtrato && tb.righe.length ? t('accessi.nessunRisultato') : tb.vuoto }}
          />
          {tb.nota && tb.filtrate.length > 0 && (
            <Text type="secondary" style={{ display: 'block', marginTop: SPACE.sm, fontSize: FONT.small }}>
              {tb.nota}
            </Text>
          )}
        </Section>
      ))}

      {dati.webUrl && (
        <Space style={{ marginTop: SPACE.lg }}>
          <Button type="primary" href={dati.webUrl} target="_blank" rel="noreferrer">
            {t('accessi.vaiTeleport')}
          </Button>
          <Text type="secondary">{t('accessi.doveSiAgisce')}</Text>
        </Space>
      )}
    </>
  )
}
