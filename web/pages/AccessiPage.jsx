import { Alert, Typography, Table, Tag, Space, Skeleton, Button, Statistic } from 'antd'
import { PageIntro, PANEL_CARD, EmptyState } from './pageKit.jsx'
import { usePoll } from '../usePoll.js'
import PollStatus from '../components/PollStatus.jsx'

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

const quando = (ts, lang) => (ts ? new Date(ts).toLocaleString(lang === 'it' ? 'it-IT' : 'en-GB') : '—')
const corta = (v) => (v && v.length > 22 ? `${v.slice(0, 19)}…` : (v ?? '—'))

export default function AccessiPage({ t, lang }) {
  // 20 secondi come le altre pagine, e con l'indicatore «aggiornato N fa»: senza, una vista che si
  // guarda durante un guasto non dice se quello che vedi e' di adesso o di dieci minuti fa.
  const { data: dati, loading, refreshing, error: errore, lastUpdated } = usePoll('/api/teleport', { intervalMs: 20000 })

  if (errore && !dati) return <Alert type="error" showIcon message={String(errore)} />
  if (loading || !dati) return <Skeleton active />

  // Senza la sezione `teleport:` nella config non si mostra un vuoto che sembra un guasto: si dice
  // cosa manca. È la stessa scelta del resto dell'app (nessun nome di risorsa cablato nel codice).
  if (!dati.configurato) {
    return (
      <>
        <PageIntro title={t('accessi.title')} desc={t('accessi.desc')} />
        <EmptyState title={t('accessi.nonConfigurato')} />
      </>
    )
  }

  const audit = dati.audit ?? {}
  const battito = dati.heartbeat ?? {}
  const versioniInGiro = battito.versioni?.length ?? 0

  const colonnePersone = [
    { title: t('accessi.col.persona'), dataIndex: 'utente', key: 'utente' },
    {
      title: t('accessi.col.login'),
      key: 'login',
      render: (_, r) =>
        r.loginFallite > 0 ? (
          <Tag color="red">{t('accessi.falliteN', { n: r.loginFallite })}</Tag>
        ) : (
          <Tag color="green">{r.loginOk}</Tag>
        ),
    },
    { title: t('accessi.col.sessioniDb'), dataIndex: 'sessioniDb', key: 'sessioniDb' },
    { title: t('accessi.col.query'), dataIndex: 'query', key: 'query' },
    // Le scritture in arancione: su un database di produzione sono la riga che si guarda per prima.
    {
      title: t('accessi.col.scritture'),
      dataIndex: 'scritture',
      key: 'scritture',
      render: (n) => (n > 0 ? <Tag color="orange">{n}</Tag> : <Tag>0</Tag>),
    },
    // Il motivo per intero, non troncato: è la riga che distingue «sessione scaduta» da «ruolo che non
    // esiste», cioè una persona sola da tutto il team fuori.
    { title: t('accessi.col.motivo'), dataIndex: 'motivo', key: 'motivo', render: (v) => v ?? '—' },
    { title: t('accessi.col.ultima'), dataIndex: 'ultima', key: 'ultima', render: (v) => quando(v, lang) },
  ]

  const colonneMacchine = [
    { title: t('accessi.col.macchina'), dataIndex: 'macchina', key: 'macchina' },
    { title: t('accessi.col.lato'), dataIndex: 'lato', key: 'lato' },
    { title: t('accessi.col.persona'), dataIndex: 'utente', key: 'utente', render: (v) => v ?? '—' },
    { title: t('accessi.col.immagine'), dataIndex: 'immagine', key: 'immagine', render: (v) => <Text code>{corta(v)}</Text> },
    {
      title: t('accessi.col.tool'),
      dataIndex: 'toolMancanti',
      key: 'tool',
      render: (n) => (n > 0 ? <Tag color="orange">{n}</Tag> : <Tag>0</Tag>),
    },
    { title: t('accessi.col.ultimoAvvio'), dataIndex: 'quando', key: 'quando', render: (v) => quando(v, lang) },
  ]

  return (
    <>
      <PageIntro
        title={t('accessi.title')}
        desc={t('accessi.desc')}
        extra={<PollStatus lastUpdated={lastUpdated} refreshing={refreshing} t={t} />}
      />

      {/* La riga dei numeri: si guarda per prima e risponde a «serve che io faccia qualcosa?». */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', margin: '0 0 16px' }}>
        <Statistic title={t('accessi.kpi.falliteN')} value={audit.loginFallite ?? 0}
          valueStyle={{ color: audit.loginFallite ? '#cf1322' : undefined }} />
        <Statistic title={t('accessi.kpi.persone')} value={audit.persone?.length ?? 0} />
        <Statistic title={t('accessi.kpi.sessioni')} value={audit.sessioniDb ?? 0} />
        <Statistic title={t('accessi.kpi.query')} value={audit.query ?? 0} />
        <Statistic title={t('accessi.kpi.scritture')} value={audit.scritture ?? 0}
          valueStyle={{ color: audit.scritture ? '#d46b08' : undefined }} />
        <Statistic title={t('accessi.kpi.macchine')} value={battito.macchine?.length ?? 0} />
        <Statistic title={t('accessi.kpi.versioni')} value={versioniInGiro}
          valueStyle={{ color: versioniInGiro > 1 ? '#d46b08' : undefined }} />
      </div>

      {/* ⚠️ Un campione spacciato per totale e' peggio di nessun numero: se il tetto e' stato toccato
          lo si dice, e i numeri qui sopra vanno letti come «almeno». */}
      {audit.troncato && (
        <Alert type="info" showIcon message={t('accessi.troncato')} style={{ marginBottom: 12 }} />
      )}

      {audit.errore && <Alert type="warning" showIcon message={audit.errore} style={{ marginBottom: 12 }} />}
      {audit.motivoPiuComune && (
        <Alert
          type="error"
          showIcon
          message={t('accessi.motivoComune', { n: audit.motivoPiuComune.quante, motivo: audit.motivoPiuComune.motivo })}
          style={{ marginBottom: 12 }}
        />
      )}
      {versioniInGiro > 1 && (
        <Alert type="warning" showIcon message={t('accessi.versioniDiverse', { n: versioniInGiro })} style={{ marginBottom: 12 }} />
      )}

      <div style={{ ...PANEL_CARD, marginBottom: 16 }}>
        <Space style={{ marginBottom: 8 }}>
          <Text strong>{t('accessi.persone')}</Text>
          <Text type="secondary">{t('accessi.ultimeOre', { n: audit.ore ?? 24 })}</Text>
        </Space>
        <Table
          size="small"
          rowKey="utente"
          pagination={false}
          columns={colonnePersone}
          dataSource={audit.persone ?? []}
          locale={{ emptyText: t('accessi.nessunAccesso') }}
        />
      </div>

      {/* Quali database vengono toccati, e da quante persone. Un database con tante query di UNA
          persona e' un lavoro in corso; lo stesso numero fatto da sei e' una dipendenza di squadra. */}
      <div style={{ ...PANEL_CARD, marginBottom: 16 }}>
        <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('accessi.database')}</Text>
        <Table
          size="small"
          rowKey={(r) => `${r.servizio}/${r.nome}`}
          pagination={false}
          columns={[
            { title: t('accessi.col.database'), dataIndex: 'nome', key: 'nome' },
            { title: t('accessi.col.servizio'), dataIndex: 'servizio', key: 'servizio' },
            {
              title: t('accessi.col.ambiente'),
              dataIndex: 'ambiente',
              key: 'ambiente',
              render: (v) => (v === 'prod' ? <Tag color="red">{v}</Tag> : v ? <Tag>{v}</Tag> : '—'),
            },
            { title: t('accessi.col.query'), dataIndex: 'query', key: 'query' },
            {
              title: t('accessi.col.scritture'),
              dataIndex: 'scritture',
              key: 'scritture',
              render: (n) => (n > 0 ? <Tag color="orange">{n}</Tag> : <Tag>0</Tag>),
            },
            { title: t('accessi.col.quantePersone'), dataIndex: 'persone', key: 'persone' },
          ]}
          dataSource={audit.database ?? []}
          locale={{ emptyText: t('accessi.nessunaQuery') }}
        />
      </div>

      <div style={{ ...PANEL_CARD, marginBottom: 16 }}>
        <Space style={{ marginBottom: 8 }}>
          <Text strong>{t('accessi.devEnv')}</Text>
          {battito.conToolMancanti > 0 && <Tag color="orange">{t('accessi.toolMancantiN', { n: battito.conToolMancanti })}</Tag>}
        </Space>
        {battito.errore && <Alert type="warning" showIcon message={battito.errore} style={{ marginBottom: 8 }} />}
        <Table
          size="small"
          rowKey={(r) => `${r.macchina}/${r.lato}`}
          pagination={false}
          columns={colonneMacchine}
          dataSource={battito.macchine ?? []}
          locale={{ emptyText: t('accessi.nessunAvvio') }}
        />
      </div>

      {dati.webUrl && (
        <Space>
          <Button type="primary" href={dati.webUrl} target="_blank" rel="noreferrer">
            {t('accessi.vaiTeleport')}
          </Button>
          <Text type="secondary">{t('accessi.doveSiAgisce')}</Text>
        </Space>
      )}
    </>
  )
}
