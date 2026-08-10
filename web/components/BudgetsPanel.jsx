import { useEffect, useState } from 'react'
import { Typography, Tag, Space, Tooltip, Alert, Badge } from 'antd'
import { PANEL_CARD, PANEL_GRID } from '../pages/pageKit.jsx'
import { LEVEL as SIGNAL, SURFACE, MONO } from '../theme.js'

const { Text } = Typography

// Livello del budget → colore/etichetta del segnale. La scala è quella della decisione: sforato /
// ci finirà / vicino / a posto.
const LEVEL = {
  over: SIGNAL.crit,
  willOver: { color: '#fa8c16', tag: 'warning' },
  warn: { color: SIGNAL.warn.color, tag: 'gold' },
  ok: SIGNAL.ok,
}

const money = (v, unit) =>
  v == null ? '—' : `${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}${unit && unit !== 'USD' ? ` ${unit}` : ' $'}`

// "2026-08-06" → "06/08". Nel formato di chi legge, e senza l'anno: in una finestra di 30 giorni
// l'anno è la stessa cifra su ogni riga. Puro.
const shortDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''))
  return m ? `${m[3]}/${m[2]}` : ''
}

// Barra del consumo: piena fino ad `actualPct`, con una tacca alla PROIEZIONE quando questa sfora.
// Due segni sulla stessa barra invece di due barre: la domanda è una sola ("quanto di quel budget"),
// e il fatto che la proiezione stia oltre il bordo si legge senza confrontare due grafici.
function BudgetBar({ b }) {
  const lvl = LEVEL[b.level] ?? LEVEL.ok
  const width = Math.min(100, b.actualPct ?? 0)
  const mark = b.forecastPct != null ? Math.min(100, b.forecastPct) : null
  return (
    <div style={{ position: 'relative', height: 6, borderRadius: 3, background: SURFACE.trackBg, overflow: 'hidden', margin: '5px 0 3px' }}>
      <div style={{ width: `${width}%`, height: '100%', background: lvl.color }} />
      {mark != null && mark > width && (
        <div style={{ position: 'absolute', left: `calc(${mark}% - 1px)`, top: 0, width: 2, height: '100%', background: lvl.color, opacity: 0.55 }} />
      )}
    </div>
  )
}

// Riga di un budget, su tre livelli invece che su una riga sola: nome+stato, la barra, poi gli importi
// con la percentuale. Prima nome e numeri stavano ai due estremi della stessa riga: su uno schermo
// largo sono un metro di distanza, e a quel punto la riga non si legge più — si leggono due colonne
// separate e si spera che l'ordine combaci.
function BudgetRow({ b, t }) {
  const lvl = LEVEL[b.level] ?? LEVEL.ok
  // L'unità di tempo si mostra solo se NON è mensile: quasi tutti i budget sono mensili, e una parola
  // identica su ogni riga non informa — occupa il posto di quelle che distinguono.
  const period = b.timeUnit && b.timeUnit !== 'MONTHLY' ? t(`budget.timeUnit.${b.timeUnit}`) : null
  return (
    <div style={{ padding: '7px 0' }}>
      <Space size={8} wrap style={{ rowGap: 2 }}>
        <Text strong style={{ fontSize: 13 }}>
          {b.name}
        </Text>
        <Tag color={lvl.tag} bordered={false} style={{ marginInlineEnd: 0, fontSize: 11 }}>
          {t(`budget.level.${b.level}`)}
        </Tag>
        {period && (
          <Text type="secondary" style={{ fontSize: 11 }}>
            {period}
          </Text>
        )}
      </Space>
      <BudgetBar b={b} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <Text type="secondary" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          {money(b.actual, b.unit)} / {money(b.limit, b.unit)}
        </Text>
        {b.actualPct != null && (
          <Text strong style={{ fontSize: 13, color: lvl.color, fontVariantNumeric: 'tabular-nums' }}>
            {b.actualPct}%
          </Text>
        )}
      </div>
      {/* La proiezione compare in due casi soli: quando sfora (è la notizia) e quando il budget è
          giallo (è il motivo per cui lo è). Su un budget verde che resta verde è una cifra in più che
          non cambia nessuna decisione — e una riga in più su ogni card. */}
      {b.forecastPct != null && (b.forecastPct >= 100 || b.level === 'warn') && (
        <Tooltip title={t('budget.forecastTip')}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {t('budget.forecast', { amount: money(b.forecast, b.unit), pct: b.forecastPct })}
          </Text>
        </Tooltip>
      )}
    </div>
  )
}

// Anomalia su due righe: l'impatto e il servizio (il "quanto" e il "chi"), sotto il contesto. Il tipo
// d'uso resta nel tooltip: è la stringa più tecnica della riga e la più lunga, e in una card stretta
// mangerebbe il posto dell'informazione che si legge prima.
function AnomalyRow({ a, t }) {
  return (
    <div style={{ padding: '6px 0' }}>
      <Space size={8} wrap style={{ rowGap: 2 }}>
        <Text strong style={{ fontSize: 13, color: '#fa8c16', fontVariantNumeric: 'tabular-nums' }}>
          +{money(a.impact)}
        </Text>
        <Text style={{ fontSize: 13 }}>{a.service ?? '—'}</Text>
        {a.feedback === 'YES' && (
          <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 11 }}>
            {t('budget.expected')}
          </Tag>
        )}
      </Space>
      <Tooltip title={a.usageType ? <span style={{ fontFamily: MONO, fontSize: 12 }}>{a.usageType}</span> : undefined}>
        <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
          {[a.account, a.impactPct != null ? t('budget.vsExpected', { pct: a.impactPct }) : null, shortDate(a.start)].filter(Boolean).join(' · ')}
        </Text>
      </Tooltip>
    </div>
  )
}

// Pannello Budget: quanto della spesa DECISA è già andata, per account, e le anomalie che AWS ha
// rilevato. Sta in cima alla pagina Spesa perché risponde alla domanda che viene prima di "quanto
// spendiamo": siamo dentro o fuori da quello che avevamo deciso.
//
// Le card stanno nella stessa griglia del resto della pagina (`PANEL_GRID`, 340–480px): un pannello
// a piena larghezza su uno schermo grande allontana l'etichetta dal suo numero fino a renderli due
// cose diverse, ed era il difetto di questa vista appena nata.
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
    <div style={{ marginBottom: 24 }}>
      {data.error && <Alert type="warning" showIcon message={data.error} style={{ marginBottom: 10 }} />}
      <div style={PANEL_GRID}>
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
              <div style={{ marginTop: 2 }}>
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
    </div>
  )
}
