import { Alert, Typography, Table, Tag, Space, Skeleton, Button } from 'antd'
import { PageIntro, PANEL_CARD, EmptyState } from './pageKit.jsx'
import { usePoll } from '../usePoll.js'

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
  // 60 secondi: la vista si guarda durante un guasto, ma dietro c'e' una lettura di log, che si paga.
  // Il server tiene comunque una cache di due minuti, quindi un giro piu' fitto non porterebbe dati
  // piu' freschi, solo richieste.
  const { data: dati, loading, error: errore } = usePoll('/api/teleport', { intervalMs: 60000 })

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
      <PageIntro title={t('accessi.title')} desc={t('accessi.desc')} />

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
