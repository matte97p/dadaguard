import { useEffect, useState } from 'react'
import { Alert, Empty, Typography, Space, Badge, Select, Segmented, Skeleton } from 'antd'
import { PageIntro, PANEL_GRID, PANEL_CARD } from './pageKit.jsx'
import CostTrend from '../components/CostTrend.jsx'
import { mergeTrend } from '../format.js'

const { Text } = Typography

const money = (v) => `${v < 0 ? '−' : ''}$${Math.abs(Number(v ?? 0)).toFixed(2)}`

// Barra orizzontale proporzionale (viola = consumo, verde = credito/rimborso). Se `projected` è dato,
// l'estensione di fine mese è un alone translucido dello STESSO colore del servizio, dietro la barra
// piena (MTD), con il valore proiettato accanto → si vede a colpo d'occhio "dove arriverà" ogni voce.
function Bar({ label, amount, max, credit, projected, t }) {
  const color = credit ? '#52c41a' : '#7c3aed'
  const base = Math.min(100, (Math.abs(amount) / max) * 100)
  const proj = projected != null ? Math.min(100, (Math.abs(projected) / max) * 100) : base
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
        <span>
          {label}
          {credit && <span style={{ marginLeft: 6, color: '#52c41a' }}>{t('costs.creditMark')}</span>}
        </span>
        <span style={{ color: amount < 0 ? '#52c41a' : undefined }}>
          {money(amount)}
          {projected != null && (
            <span style={{ marginLeft: 6, color }} title={t('costs.projection')}>
              → {money(projected)}
            </span>
          )}
        </span>
      </div>
      <div style={{ position: 'relative', height: 8, borderRadius: 4, background: 'rgba(128,128,128,0.15)' }}>
        {projected != null && (
          <div
            style={{ position: 'absolute', insetBlock: 0, left: 0, width: `${proj}%`, borderRadius: 4, background: color, opacity: 0.28 }}
          />
        )}
        <div
          style={{ position: 'absolute', insetBlock: 0, left: 0, width: `${base}%`, borderRadius: 4, background: color }}
        />
      </div>
    </div>
  )
}

// Pagina Costi: consumo per servizio (viola) + crediti/rimborsi (verde) = netto, per account.
// Cost Explorer è a pagamento → fetch on-mount e al cambio mese.
export default function CostsPage({ accountLabels, t = (k) => k, lang }) {
  const [data, setData] = useState(null)
  // `true` da subito: al mount una richiesta parte SEMPRE, quindi partire da `false` dipingeva un
  // primo fotogramma vuoto (nessuno scheletro, nessun dato) prima che l'effetto la facesse partire.
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [trend, setTrend] = useState(null)
  const [comps, setComps] = useState(null)
  const [trendMetric, setTrendMetric] = useState('usage') // 'usage' = tutto · 'infra' = senza AI
  const [cats, setCats] = useState(null)
  // Un flag per sezione: senza, "sto ancora arrivando" e "non c'è niente" sono indistinguibili — e la
  // sezione compariva di colpo, spostando quello che stavi leggendo.
  const [trendLoading, setTrendLoading] = useState(true)
  const [compsLoading, setCompsLoading] = useState(true)
  const [catsLoading, setCatsLoading] = useState(true)
  const [type, setType] = useState('all') // filtro Livello (Cost Category), come il "TYPE" di analytics

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/costs?month=${month}&type=${type}&lang=${lang}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [month, type, lang])

  // Il trend NON dipende dal mese scelto (sono gli ultimi 13 mesi): si carica una volta, così
  // cambiare mese non rifà una chiamata a pagamento. I componenti invece sono del mese selezionato.
  useEffect(() => {
    setTrendLoading(true)
    fetch(`/api/costs/trend?type=${type}&lang=${lang}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setTrend)
      .catch(() => setTrend(null)) // il trend è un extra: se manca, la pagina resta utile
      .finally(() => setTrendLoading(false))
  }, [type, lang])

  useEffect(() => {
    setCompsLoading(true)
    fetch(`/api/costs/components?month=${month}&type=${type}&lang=${lang}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setComps)
      .catch(() => setComps(null))
      .finally(() => setCompsLoading(false))
  }, [month, type, lang])

  // I livelli NON si filtrano per livello: questa è la vista che li mostra, e dà anche i valori al
  // menu — così sapere quali livelli esistono non costa una chiamata in più.
  useEffect(() => {
    setCatsLoading(true)
    fetch(`/api/costs/categories?month=${month}&lang=${lang}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setCats)
      .catch(() => setCats(null))
      .finally(() => setCatsLoading(false))
  }, [month, lang])

  const accounts = (data ? Object.entries(data) : []).filter(
    ([, acc]) => !accountLabels || accountLabels.has(acc.label),
  )
  // Opzioni del filtro: i livelli che ESISTONO in questo mese, sommati su tutti gli account. Un
  // elenco scritto a mano andrebbe stantio al primo livello nuovo (e la Cost Category cambia: la
  // tassonomia di Cato è stata rivista di recente).
  const typeOptions = (() => {
    const seen = new Map()
    for (const acc of cats ? Object.values(cats) : []) {
      if (acc.error) continue
      for (const c of acc.categories ?? []) {
        if (!c.category) continue // il non-categorizzato non è un filtro: si guarda dalla ripartizione
        seen.set(c.category, (seen.get(c.category) ?? 0) + c.amount)
      }
    }
    return [
      { value: 'all', label: t('costs.type.all') },
      ...[...seen.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => ({ value, label: value })),
    ]
  })()

  const now = new Date()
  const monthOptions = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    return { value, label: i === 0 ? `${label} · ${t('costs.current')}` : label }
  })

  return (
    <>
      <PageIntro
        title={t('costs.title')}
        desc={t('costs.desc')}
        extra={
          <Space size={10} wrap>
            <Space size={6}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('costs.type')}
              </Text>
              <Select size="small" value={type} onChange={setType} options={typeOptions} style={{ minWidth: 150 }} />
            </Space>
            <Space size={6}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('costs.month')}
              </Text>
              <Select size="small" value={month} onChange={setMonth} options={monthOptions} style={{ minWidth: 170 }} />
            </Space>
          </Space>
        }
      />
      {loading && !data && <CostsSkeleton />}
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}
      {/* Due vuoti diversi: nessun account leggibile, oppure un filtro che li nasconde tutti. Dirli
          allo stesso modo manda a cercare un problema di configurazione che non esiste. */}
      {data && accounts.length === 0 && (
        <Empty
          description={Object.keys(data).length > 0 ? t('costs.allFiltered') : t('costs.noAccounts')}
          style={{ marginTop: 24 }}
        />
      )}

      {accounts.length > 0 &&
        (() => {
          // Totali aggregati su tutti gli account monitorati → il colpo d'occhio che mancava.
          const sum = (f) => accounts.reduce((s, [, a]) => s + (f(a) || 0), 0)
          const gross = sum((a) => a.gross)
          const credits = sum((a) => a.credits)
          const net = sum((a) => (a.total != null ? a.total : a.gross))
          const proj = sum((a) => (a.projection ? a.projection.gross : a.gross))
          const tax = sum((a) => a.tax)
          const ai = sum((a) => a.aiGross)
          const hasCred = Math.abs(credits) > 0.005
          const hasTax = Math.abs(tax) > 0.005
          const hasAi = Math.abs(ai) > 0.005
          const Hero = ({ label, value, size = 22, color }) => (
            <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.15 }}>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {label}
              </Text>
              <span style={{ fontSize: size, fontWeight: 700, color }}>{value}</span>
            </span>
          )
          return (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 36px', alignItems: 'flex-end', margin: '4px 0 18px' }}>
              <Hero label={t('costs.h.gross')} value={money(gross)} />
              {hasCred && <Hero label={t('costs.h.credits')} value={money(credits)} size={18} color="#52c41a" />}
              {hasCred && <Hero label={t('costs.h.net')} value={money(net)} size={18} />}
              {hasTax && <Hero label={t('costs.h.tax')} value={money(tax)} size={18} />}
              {/* L'AI a parte: con i modelli che valgono la maggior parte del conto, un totale unico
                  nasconde l'andamento dell'infrastruttura — sale l'uso dei modelli e sembra che sia
                  cresciuto tutto. Due numeri, due domande diverse. */}
              {hasAi && <Hero label={t('costs.h.ai')} value={money(ai)} size={18} color="#7c3aed" />}
              {hasAi && <Hero label={t('costs.h.infra')} value={money(gross - ai)} size={18} />}
              <Hero label={t('costs.h.proj')} value={money(proj)} size={18} color="#8c8c8c" />
            </div>
          )
        })()}

      {/* Trend: la domanda "sta crescendo?", che un mese solo non può rispondere. Somma degli account
          visibili, così il grafico parla del conto e non di un pezzo per volta. */}
      {(() => {
        const rows = trend
          ? mergeTrend(
              Object.values(trend).filter((a) => !a.error && (!accountLabels || accountLabels.has(a.label))),
            )
          : []
        // Mentre arriva, uno scheletro ALTO COME il grafico: se lo spazio non è riservato, quando i
        // dati atterrano tutto quello che c'è sotto scivola giù e si perde il punto in cui si leggeva.
        if (trendLoading && !trend) {
          return (
            <div style={{ ...PANEL_CARD, marginBottom: 16 }}>
              <Skeleton active title={{ width: 180 }} paragraph={{ rows: 1, width: '55%' }} />
              <Skeleton.Node active style={{ width: '100%', height: 210 }}>
                <span />
              </Skeleton.Node>
            </div>
          )
        }
        if (rows.length < 2) return null
        return (
          <div style={{ ...PANEL_CARD, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <Text strong>{t('costs.trend.title')}</Text>
                <div>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {t('costs.trend.desc')}
                  </Text>
                </div>
              </div>
              <Segmented
                size="small"
                value={trendMetric}
                onChange={setTrendMetric}
                options={[
                  { value: 'usage', label: t('costs.trend.all') },
                  { value: 'infra', label: t('costs.trend.noAi') },
                ]}
              />
            </div>
            <div style={{ marginTop: 8 }}>
              <CostTrend months={rows} metric={trendMetric} t={t} lang={lang} />
            </div>
          </div>
        )
      })()}

      <div style={PANEL_GRID}>
        {accounts.map(([key, acc]) => {
          if (acc.error) {
            return (
              <div key={key} style={PANEL_CARD}>
                <Space>
                  {acc.color && <Badge color={acc.color} />}
                  <Text strong>{acc.label}</Text>
                </Space>
                <Alert type="warning" showIcon style={{ marginTop: 8 }} message={acc.error} />
              </div>
            )
          }
          const items = acc.items ?? []
          const hasCredits = Math.abs(acc.credits ?? 0) > 0.005
          // Stesso run-rate della proiezione aggregata, applicato per-servizio (solo mese corrente).
          const factor = acc.projection ? acc.projection.daysInMonth / acc.projection.daysElapsed : null
          // il max include le proiezioni, così gli aloni di fine mese entrano nella barra.
          const max = Math.max(
            1,
            ...items.map((i) => Math.abs(i.amount) * (factor ?? 1)),
            Math.abs(acc.credits ?? 0),
          )
          return (
            <div key={key} style={PANEL_CARD}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <Space>
                  {acc.color && <Badge color={acc.color} />}
                  <Text strong>{acc.label}</Text>
                </Space>
                <div style={{ textAlign: 'right' }}>
                  <Text strong style={{ fontSize: 18 }}>
                    {money(acc.gross)}
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {' '}
                      {t('costs.gross')}
                    </Text>
                  </Text>
                  {acc.projection && (
                    <div style={{ marginTop: 2 }}>
                      <Text style={{ fontSize: 12 }}>
                        {t('costs.projection')} <Text strong>{money(acc.projection.gross)}</Text>
                      </Text>
                      <div>
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {t('costs.projectionBasis', {
                            d: acc.projection.daysElapsed,
                            tot: acc.projection.daysInMonth,
                            pct: acc.projection.pct,
                          })}
                        </Text>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* I crediti si scalano SEMPRE a parte: il numero grande è il lordo (quello che pagherai a
                  crediti esauriti), i crediti sono una riga di detrazione esplicita e il netto ne è il residuo. */}
              {hasCredits && (
                <div style={{ marginTop: 4 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('costs.credits', { v: money(acc.credits) })}
                    {' · '}
                    {t('costs.netAfter', { v: money(acc.total) })}
                  </Text>
                </div>
              )}

              {items.length === 0 && !hasCredits ? (
                <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                  {t('costs.none')}
                </Text>
              ) : (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {items.map((it) => (
                    <Bar
                      key={it.service}
                      label={it.service}
                      amount={it.amount}
                      projected={factor ? it.amount * factor : null}
                      max={max}
                      t={t}
                    />
                  ))}
                  {hasCredits && (
                    <Bar label={t('costs.creditsRefunds')} amount={acc.credits} max={max} credit t={t} />
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Ripartizione per LIVELLO (Cost Category): il "type" della pagina di analytics. Non risente del
          filtro Livello — è la vista che lo mostra, e filtrarla su un valore la ridurrebbe a una riga. */}
      {(() => {
        const list = cats
          ? Object.entries(cats).filter(([, a]) => !a.error && (!accountLabels || accountLabels.has(a.label)))
          : []
        if (catsLoading && !cats) return <SectionSkeleton />
        if (list.length === 0) return null
        return (
          <>
            <div style={{ margin: '20px 0 8px' }}>
              <Text strong>{t('costs.cat.title')}</Text>
              <div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {t('costs.cat.desc', { cat: list[0][1].categoryName ?? 'Livello' })}
                </Text>
              </div>
            </div>
            <div style={PANEL_GRID}>
              {list.map(([key, acc]) => {
                const rows = acc.categories ?? []
                const max = Math.max(1, ...rows.map((c) => Math.abs(c.amount)))
                return (
                  <div key={key} style={PANEL_CARD}>
                    <Space>
                      {acc.color && <Badge color={acc.color} />}
                      <Text strong>{acc.label}</Text>
                    </Space>
                    <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 10 }}>
                      {rows.map((c) => (
                        <details key={c.category ?? '__none__'}>
                          <summary className="dg-summary">
                            <span className="dg-chev" aria-hidden="true">
                              ▸
                            </span>
                            <span style={{ flex: 1, minWidth: 0 }}>
                              <Bar label={c.category ?? t('costs.cat.none')} amount={c.amount} max={max} t={t} />
                            </span>
                          </summary>
                          <div style={{ marginTop: 6, marginInlineStart: 10 }}>
                            {c.services.map((sv) => (
                              <div
                                key={sv.service}
                                style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, opacity: 0.75 }}
                              >
                                <span>{sv.service}</span>
                                <span className="dg-num">{money(sv.amount)}</span>
                              </div>
                            ))}
                          </div>
                        </details>
                      ))}
                    </Space>
                  </div>
                )
              })}
            </div>
          </>
        )
      })()}

      {/* Attribuzione per COMPONENTE: il servizio AWS dice cosa costa, il tag dice di chi è — ed è il
          secondo a far decidere. Il non-taggato resta in lista: nasconderlo farebbe sembrare
          l'attribuzione completa quando non lo è. */}
      {(() => {
        const list = comps
          ? Object.entries(comps).filter(([, a]) => !a.error && (!accountLabels || accountLabels.has(a.label)))
          : []
        if (compsLoading && !comps) return <SectionSkeleton />
        if (list.length === 0) return null
        return (
          <>
            <div style={{ margin: '20px 0 8px' }}>
              <Text strong>{t('costs.comp.title')}</Text>
              <div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {t('costs.comp.desc', { tag: list[0][1].tagKey ?? 'component' })}
                </Text>
              </div>
            </div>
            <div style={PANEL_GRID}>
              {list.map(([key, acc]) => {
                const rows = acc.components ?? []
                const max = Math.max(1, ...rows.map((c) => Math.abs(c.amount)))
                return (
                  <div key={key} style={PANEL_CARD}>
                    <Space>
                      {acc.color && <Badge color={acc.color} />}
                      <Text strong>{acc.label}</Text>
                    </Space>
                    {rows.length === 0 ? (
                      <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                        {t('costs.comp.none')}
                      </Text>
                    ) : rows.length === 1 && rows[0].component === null ? (
                      // Tutto in un'unica voce non taggata: quasi sempre il tag non è attivo come cost
                      // allocation tag, o è scritto con un'altra maiuscola (Cost Explorer è
                      // case-sensitive e non dà errore: dà "non taggato"). Meglio dire il sospetto che
                      // mostrare una riga sola e lasciar pensare che sia l'attribuzione vera.
                      <Alert
                        type="info"
                        showIcon
                        style={{ marginTop: 8 }}
                        message={t('costs.comp.allUntagged', { tag: acc.tagKey ?? 'Component' })}
                      />
                    ) : (
                      <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 10 }}>
                        {rows.map((c) => (
                          <details key={c.component ?? '__untagged__'}>
                            {/* Il marcatore predefinito di <summary> lo rende `display:list-item` e
                                manda la barra a capo: freccetta nostra, riga in flex. */}
                            <summary className="dg-summary">
                              <span className="dg-chev" aria-hidden="true">
                                ▸
                              </span>
                              <span style={{ flex: 1, minWidth: 0 }}>
                                <Bar label={c.component ?? t('costs.comp.untagged')} amount={c.amount} max={max} t={t} />
                              </span>
                            </summary>
                            <div style={{ marginTop: 6, marginInlineStart: 10 }}>
                              {c.services.map((sv) => (
                                <div key={sv.service} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, opacity: 0.75 }}>
                                  <span>{sv.service}</span>
                                  <span className="dg-num">{money(sv.amount)}</span>
                                </div>
                              ))}
                            </div>
                          </details>
                        ))}
                      </Space>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )
      })()}
    </>
  )
}

// Scheletro della pagina: la FORMA che arriverà (riquadri in alto, grafico, pannelli), non uno
// spinner al centro. Uno spinner dice "attendi" e poi fa saltare la pagina di 600px; lo scheletro
// tiene lo spazio, così quando i dati atterrano nulla si sposta. Mostrato solo al PRIMO caricamento:
// cambiando mese i dati vecchi restano visibili, che è meglio di un vuoto.
function CostsSkeleton() {
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 36px', alignItems: 'flex-end', margin: '4px 0 18px' }}>
        {[86, 70, 78, 54, 120, 92, 74].map((w, i) => (
          <Skeleton.Button key={i} active size="small" style={{ width: w, height: 38 }} />
        ))}
      </div>
      <div style={{ ...PANEL_CARD, marginBottom: 16 }}>
        <Skeleton active title={{ width: 180 }} paragraph={{ rows: 1, width: '55%' }} />
        <Skeleton.Node active style={{ width: '100%', height: 210 }}>
          <span />
        </Skeleton.Node>
      </div>
      <div style={PANEL_GRID}>
        {[4, 2, 2].map((rows, i) => (
          <div key={i} style={PANEL_CARD}>
            <Skeleton active title={{ width: 140 }} paragraph={{ rows, width: '100%' }} />
          </div>
        ))}
      </div>
    </>
  )
}

// Scheletro di una sezione a pannelli (Per livello / Per componente): titolo + due pannelli.
function SectionSkeleton() {
  return (
    <>
      <div style={{ margin: '20px 0 8px' }}>
        <Skeleton active title={{ width: 130 }} paragraph={{ rows: 1, width: '45%' }} />
      </div>
      <div style={PANEL_GRID}>
        {[3, 2].map((rows, i) => (
          <div key={i} style={PANEL_CARD}>
            <Skeleton active title={{ width: 120 }} paragraph={{ rows, width: '100%' }} />
          </div>
        ))}
      </div>
    </>
  )
}
