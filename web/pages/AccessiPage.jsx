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
  digestCorto,
  durataFallite,
  filtraRighe,
  immagineRiferimento,
  linkAudit,
  macchinaDiversa,
  macchinaIndietro,
  personaMacchina,
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

// I comparatori delle colonne: servono ad antd per il riordino a mano, e non sono regole della pagina
// (quelle stanno in `web/accessi.js`, provate).
const numerico = (campo) => (a, b) => (a[campo] ?? 0) - (b[campo] ?? 0)
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
    typeof localStorage === 'undefined' ? 'persone' : (localStorage.getItem('dadaguard-accessi-view') ?? 'persone'),
  )
  const vista = params.get('vista') ?? ricordata
  const [soloProblemi, setSoloProblemi] = useState(false)
  const [query, setQuery] = useState('')

  const scegliVista = (v) => {
    setRicordata(v)
    if (typeof localStorage !== 'undefined') localStorage.setItem('dadaguard-accessi-view', v)
    const prossimi = new URLSearchParams(params)
    prossimi.set('vista', v)
    setParams(prossimi, { replace: true })
  }

  // 20 secondi come le altre pagine, e con l'indicatore «aggiornato N fa»: senza, una vista che si
  // guarda durante un guasto non dice se quello che vedi e' di adesso o di dieci minuti fa.
  const { data: dati, loading, refreshing, error: errore, lastUpdated } = usePoll(`/api/teleport?ore=${ore}`, {
    intervalMs: 20000,
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
  const indietro = (m) => macchinaIndietro(m, riferimento)
  const diversa = (m) => macchinaDiversa(m, riferimento)
  const versioniInGiro = battito.versioni?.length ?? 0
  // I nomi che Teleport conosce: servono a scegliere quale dei due nomi della stessa persona mostrare
  // sulla riga di una macchina (l'heartbeat manda l'utente di sistema quando non c'è una sessione).
  const utentiNoti = useMemo(() => new Set((audit.persone ?? []).map((p) => p.utente)), [audit.persone])

  const persone = useMemo(() => ordinaPersone(audit.persone ?? []), [audit.persone])
  const database = useMemo(() => ordinaDatabase(audit.database ?? []), [audit.database])
  const macchine = useMemo(() => ordinaMacchine(battito.macchine ?? [], riferimento), [battito.macchine, riferimento])
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
    { title: t('accessi.col.sessioniDb'), dataIndex: 'sessioniDb', key: 'sessioniDb', sorter: numerico('sessioniDb') },
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
              {t('accessi.img.indietro')}
            </Tag>
          ) : diversa(r) ? (
            <Tag style={{ marginInlineEnd: 0 }}>{t('accessi.img.diversa')}</Tag>
          ) : null}
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

  // Le quattro tabelle come DATI, non come quattro blocchi copiati: l'interruttore, il conteggio, il
  // pallino, il filtro e la ricerca si scrivono una volta e valgono per tutte.
  const viste = [
    {
      value: 'persone',
      label: t('accessi.view.persone'),
      titolo: t('accessi.persone'),
      righe: persone,
      colonne: colonnePersone,
      rowKey: (r) => r.utente,
      problema: problemaPersona,
      livello: 'crit',
      cerca: (p) => [p.utente, p.motivo],
      vuoto: t('accessi.nessunAccesso'),
      finestra: t('accessi.ultimeOre', { n: audit.ore ?? ore }),
    },
    {
      value: 'database',
      label: t('accessi.view.database'),
      titolo: t('accessi.database'),
      righe: database,
      colonne: colonneDatabase,
      rowKey: (r) => `${r.servizio}/${r.nome}`,
      problema: problemaDatabase,
      livello: 'crit',
      cerca: (d) => [d.nome, d.servizio, d.ambiente],
      vuoto: t('accessi.nessunaQuery'),
      finestra: t('accessi.ultimeOre', { n: audit.ore ?? ore }),
    },
    {
      value: 'devEnv',
      label: t('accessi.view.devEnv'),
      titolo: t('accessi.devEnv'),
      righe: macchine,
      colonne: colonneMacchine,
      rowKey: (r) => `${r.macchina}/${r.lato}`,
      problema: (m) => problemaMacchina(m, riferimento),
      livello: 'warn',
      cerca: (m) => [m.macchina, m.utente, m.immagine],
      vuoto: t('accessi.nessunAvvio'),
      finestra: `${t('accessi.ultimiGiorni', { n: battito.giorni ?? 7 })} · ${
        riferimento.fonte === 'config' ? t('accessi.fonte.config') : t('accessi.fonte.vista')
      }`,
    },
    {
      value: 'ssh',
      label: t('accessi.view.ssh'),
      titolo: t('accessi.ssh'),
      righe: ssh,
      colonne: colonneSsh,
      rowKey: (r) => r.macchina,
      problema: problemaSsh,
      livello: 'crit',
      cerca: (m) => [m.macchina, ...(m.chi ?? [])],
      vuoto: t('accessi.nessunaSsh'),
      finestra: t('accessi.ultimeOre', { n: audit.ore ?? ore }),
      nota: t('accessi.sshRegistrate'),
    },
  ]

  const attiva = viste.find((v) => v.value === vista) ?? viste[0]
  const righe = filtraRighe(attiva.righe, {
    problema: attiva.problema,
    cerca: attiva.cerca,
    query,
    soloProblemi,
  })
  const filtrato = Boolean(query.trim()) || soloProblemi

  // I segnali che valgono per TUTTA la pagina, contati una volta: decidono se la riga verde «tutto
  // tranquillo» ha il diritto di esserci. Un riepilogo che tace quando va tutto bene lascia chi guarda
  // a chiedersi se la pagina ha caricato.
  const quante = daGuardare(audit, battito, riferimento)
  const sintesi = riepilogo(audit, battito, riferimento)
  const nessunoAggiornato = tuttiIndietro(battito.macchine ?? [], riferimento)

  return (
    <>
      <PageIntro
        title={t('accessi.title')}
        desc={t('accessi.desc')}
        extra={
          <Toolbar>
            <PollStatus lastUpdated={lastUpdated} refreshing={refreshing} t={t} />
            {/* L'interruttore fra le quattro tabelle porta il conteggio e, quando dentro c'è qualcosa da
                guardare, un pallino colorato: così una tabella chiusa non nasconde un segnale, ed è la
                condizione per mostrarne una sola invece di quattro in colonna. */}
            <Segmented
              size="small"
              value={attiva.value}
              onChange={scegliVista}
              options={viste.map((v) => {
                const guasti = v.righe.filter(v.problema).length
                return {
                  value: v.value,
                  label: (
                    <span
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                      title={guasti ? t('accessi.daGuardare', { n: guasti }) : undefined}
                    >
                      {v.label}
                      <span style={{ fontSize: FONT.micro, opacity: 0.55 }}>{v.righe.length}</span>
                      {guasti > 0 && (
                        <span
                          aria-label={t('accessi.daGuardare', { n: guasti })}
                          role="img"
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 3,
                            background: LEVEL[v.livello].color,
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
              {v.k === 'scritture'
                ? t(v.prod ? 'accessi.sintesi.scrittureProd' : 'accessi.sintesi.scritture', {
                    n: v.n,
                    dove: v.dove.join(', '),
                  })
                : v.k === 'versioni'
                  ? t(v.tutti ? 'accessi.sintesi.versioniTutti' : 'accessi.sintesi.versioni', { n: v.n })
                  : t(`accessi.sintesi.${v.k}`, { n: v.n })}
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
        <HeroStat label={t('accessi.kpi.ssh')} value={audit.sessioniSsh ?? 0} size={18} />
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
      {audit.motivoPiuComune && (
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
      {nessunoAggiornato && (
        <Alert type="error" showIcon message={t('accessi.nessunoAggiornato')} style={{ marginBottom: SPACE.md }} />
      )}
      {/* ⚠️ Prima diceva «qualcuno è rimasto indietro» su un dato che non lo sa. Con cinque macchine e
          cinque digest diversi (dati veri del 31/08/2026) versioni diverse vuol dire solo che ognuno ha
          l'immagine che ha scaricato: chi è indietro lo si può dire solo con la versione attesa in
          config, e senza quella l'avviso lo dichiara e dice come metterla. */}
      {versioniInGiro > 1 && (
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
      )}
      {/* Le macchine che non hanno dichiarato la versione: contate a parte, perché non sono «indietro»
          e non sono «pari», e finivano dentro il conteggio delle versioni come se fossero una versione. */}
      {battito.senzaVersione > 0 && (
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

      <Section
        title={attiva.titolo}
        aside={
          <Text type="secondary" style={{ fontSize: FONT.small }}>
            {attiva.finestra}
          </Text>
        }
      >
        <Table
          size="small"
          className="dg-sticky"
          rowKey={attiva.rowKey}
          pagination={false}
          columns={attiva.colonne}
          dataSource={righe}
          locale={{ emptyText: filtrato && attiva.righe.length ? t('accessi.nessunRisultato') : attiva.vuoto }}
        />
        {attiva.nota && righe.length > 0 && (
          <Text type="secondary" style={{ display: 'block', marginTop: SPACE.sm, fontSize: FONT.small }}>
            {attiva.nota}
          </Text>
        )}
      </Section>

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
