import { useEffect, useState } from 'react'
import { Typography, Tag, Space, Tooltip, Alert, Badge } from 'antd'
import { PANEL_CARD } from '../pages/pageKit.jsx'

const { Text } = Typography
const MONO = 'ui-monospace, SFMono-Regular, monospace'

// Un livello per colore, e la scala è quella della decisione: sforato / ci finirà / vicino / a posto.
const LEVEL = {
  over: { color: '#cf1322', tag: 'error' },
  willOver: { color: '#fa8c16', tag: 'warning' },
  warn: { color: '#faad14', tag: 'gold' },
  ok: { color: '#52c41a', tag: 'success' },
}

const money = (v, unit) =>
  v == null ? '—' : `${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}${unit && unit !== 'USD' ? ` ${unit}` : ' $'}`

// Barra del consumo: piena fino ad `actualPct`, con un tacca alla PROIEZIONE quando questa sfora.
// Due segni sulla stessa barra invece di due barre: la domanda è una sola ("quanto di quel budget"),
// e il fatto che la proiezione stia oltre il bordo si legge senza confrontare due grafici.
function BudgetBar({ b }) {
  const lvl = LEVEL[b.level] ?? LEVEL.ok
  const width = Math.min(100, b.actualPct ?? 0)
  const mark = b.forecastPct != null ? Math.min(100, b.forecastPct) : null
  return (
    <div style={{ position: 'relative', height: 6, borderRadius: 3, background: 'rgba(128,128,128,0.18)', overflow: 'hidden', marginTop: 4 }}>
      <div style={{ width: `${width}%`, height: '100%', background: lvl.color }} />
      {mark != null && mark > width && (
        <div style={{ position: 'absolute', left: `calc(${mark}% - 1px)`, top: 0, width: 2, height: '100%', background: lvl.color, opacity: 0.55 }} />
      )}
    </div>
  )
}

function BudgetRow({ b, t }) {
  const lvl = LEVEL[b.level] ?? LEVEL.ok
  return (
    <div style={{ padding: '6px 0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <Text strong style={{ fontSize: 13 }}>
          {b.name}
        </Text>
        <Tag color={lvl.tag} bordered={false} style={{ marginInlineEnd: 0, fontSize: 11 }}>
          {t(`budget.level.${b.level}`)}
        </Tag>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {t(`budget.timeUnit.${b.timeUnit ?? 'MONTHLY'}`)}
        </Text>
        <span style={{ flex: 1 }} />
        <Text style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
          {money(b.actual, b.unit)} / {money(b.limit, b.unit)}
        </Text>
        {b.actualPct != null && (
          <Text strong style={{ fontSize: 13, color: lvl.color, fontVariantNumeric: 'tabular-nums', minWidth: 44, textAlign: 'right' }}>
            {b.actualPct}%
          </Text>
        )}
      </div>
      <BudgetBar b={b} />
      {/* La proiezione si mostra solo quando dice qualcosa in più del consumo: se è sotto il limite e
          il consumo è tranquillo, è una cifra che non cambia nessuna decisione. */}
      {b.forecastPct != null && (b.forecastPct >= 100 || b.forecastPct - (b.actualPct ?? 0) > 25) && (
        <Tooltip title={t('budget.forecastTip')}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {t('budget.forecast', { amount: money(b.forecast, b.unit), pct: b.forecastPct })}
          </Text>
        </Tooltip>
      )}
    </div>
  )
}

function AnomalyRow({ a, t }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', padding: '5px 0' }}>
      <Text strong style={{ fontSize: 13, color: '#fa8c16', fontVariantNumeric: 'tabular-nums' }}>
        +{money(a.impact)}
      </Text>
      <Text style={{ fontSize: 13 }}>{a.service ?? '—'}</Text>
      {a.account && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {a.account}
        </Text>
      )}
      {a.impactPct != null && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('budget.vsExpected', { pct: a.impactPct })}
        </Text>
      )}
      {a.usageType && (
        <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
          {a.usageType}
        </Text>
      )}
      <Text type="secondary" style={{ fontSize: 11 }}>
        {String(a.start ?? '').slice(0, 10)}
      </Text>
      {/* Già marcata come attesa da qualcuno: resta in elenco (è successa) ma smette di allarmare. */}
      {a.feedback === 'YES' && (
        <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 11 }}>
          {t('budget.expected')}
        </Tag>
      )}
    </div>
  )
}

// Pannello Budget: quanto della spesa DECISA è già andata, per account, e le anomalie che AWS ha
// rilevato. Sta in cima alla pagina Costi perché risponde alla domanda che viene prima di "quanto
// spendiamo": siamo dentro o fuori da quello che avevamo deciso.
export default function BudgetsPanel({ t = (k) => k, lang }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  // Vedi WafPanel: con `destroyOnHidden` sulle schede, questo pannello si smonta cambiando scheda.
  useEffect(() => {
    let alive = true
    fetch(`/api/budgets?lang=${lang ?? ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => alive && setData(j))
      .catch((e) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [lang])

  if (error) return <Alert type="warning" showIcon message={error} style={{ marginBottom: 16 }} />
  if (!data) return null

  const accounts = Object.entries(data.accounts ?? {}).filter(([, a]) => a.error || (a.budgets?.length ?? 0) > 0)
  const anomalies = data.anomalies ?? []
  // Nessun budget e nessuna anomalia: niente sezione. Un pannello vuoto non insegna nulla e occupa
  // la parte alta della pagina, che è quella che si legge.
  if (accounts.length === 0 && anomalies.length === 0 && !data.error && !data.anomaliesError) return null

  return (
    <div style={{ marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {data.error && <Alert type="warning" showIcon message={data.error} />}
      {accounts.map(([key, a]) => (
        <div key={key} style={PANEL_CARD}>
          <Space>
            {a.color && <Badge color={a.color} />}
            <Text strong style={{ fontSize: 15 }}>
              {a.label}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('budget.title')}
            </Text>
          </Space>
          {a.error ? (
            <Alert type="warning" showIcon style={{ marginTop: 8 }} message={a.error} />
          ) : (
            <div style={{ marginTop: 4 }}>
              {a.budgets.map((b) => (
                <BudgetRow key={b.name} b={b} t={t} />
              ))}
            </div>
          )}
        </div>
      ))}

      {(anomalies.length > 0 || data.anomaliesError) && (
        <div style={PANEL_CARD}>
          <Text strong style={{ fontSize: 15 }}>
            {t('budget.anomalies')}
          </Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
            {t('budget.anomaliesDesc')}
          </Text>
          {data.anomaliesError ? (
            <Alert type="warning" showIcon style={{ marginTop: 8 }} message={data.anomaliesError} />
          ) : (
            <div style={{ marginTop: 4 }}>
              {anomalies.map((a) => (
                <AnomalyRow key={a.id} a={a} t={t} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
