import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Verdetto, Tabs, Lista, Sezione, Card, Pill, stileGriglia } from '../ui/index.js'
import Loading from '../components/Loading.jsx'
import './ops.css'

// Raggruppa le azioni per servizio (prefisso prima dei ':'): "s3:GetObject" → { s3: [GetObject] }.
function actionsByService(actions) {
  const m = new Map()
  for (const a of actions) {
    const [svc, act] = a.includes(':') ? [a.slice(0, a.indexOf(':')), a.slice(a.indexOf(':') + 1)] : ['*', a]
    if (!m.has(svc)) m.set(svc, [])
    m.get(svc).push(act)
  }
  return [...m.entries()]
}

// Le azioni come etichette, una per servizio: «s3: GetObject, PutObject». Sono le chip neutre della
// nuova interfaccia: qui non c'e' uno stato da colorare, c'e' un elenco da leggere.
function ActionTags({ actions }) {
  return (
    <span className="ui-who">
      {actionsByService(actions).map(([svc, acts]) => (
        <b key={svc} className="ui-mono" style={{ marginInlineEnd: 4, marginBottom: 4 }}>
          {svc}: {acts.join(', ')}
        </b>
      ))}
    </span>
  )
}

// Ruoli, utenti e gruppi in tre righe di una lista: l'etichetta a sinistra, i nomi a destra.
function Entities({ entities, t }) {
  const righe = [
    [t('iam.roles'), entities.roles],
    [t('iam.users'), entities.users],
    [t('iam.groups'), entities.groups],
  ]
  return (
    <Lista griglia="90px minmax(0, 1fr)" grigliaMobile="90px minmax(0, 1fr)">
      {righe.map(([label, items]) => (
        <div key={label} className="ui-row">
          <span className="ui-mute">{label}</span>
          {/* `.ui-who` dentro a uno span, non figlio diretto della riga: sul telefono ui.css nasconde
              `.ui-row > .ui-who` (il «di chi» delle righe problema), e qui e' l'unica colonna utile. */}
          <span>
            <span className="ui-who">
              {items.length ? (
                items.map((n) => (
                  <b key={n} style={{ marginInlineEnd: 4 }}>
                    {n}
                  </b>
                ))
              ) : (
                <span className="ui-faint">{t('iam.noneEntity')}</span>
              )}
            </span>
          </span>
        </div>
      ))}
    </Lista>
  )
}

// Assegnazioni SSO: ogni riga è una persona o un gruppo; per i gruppi elenca i membri, così "chi c'è
// dentro" non resta opaco. Il gruppo prende la pillola viola del marchio, la persona quella neutra:
// non sono stati, sono due tipi diversi di chi.
function Assignments({ items, t }) {
  return (
    <Lista griglia="96px minmax(0, 1fr)" grigliaMobile="96px minmax(0, 1fr)">
      {items.map((a, i) => (
        <div key={i} className="ui-row">
          <Pill livello={a.type === 'group' ? 'info' : 'off'}>{a.type === 'group' ? t('iam.group') : t('iam.persona')}</Pill>
          <span className="ui-name">
            {a.name}
            <small>{a.account}</small>
            {a.type === 'group' && (
              <span className="ui-hint">
                {a.members === undefined ? (
                  t('iam.membersUnreadable')
                ) : a.members.length === 0 ? (
                  t('iam.emptyGroup')
                ) : (
                  <span className="ui-who">
                    {a.members.map((m) => (
                      <b key={m} style={{ marginInlineEnd: 4 }}>
                        {m}
                      </b>
                    ))}
                  </span>
                )}
              </span>
            )}
          </span>
        </div>
      ))}
    </Lista>
  )
}

// --- Vista "Per policy": elenco policy per account + dettaglio (chi la usa / a cosa dà accesso). ---
function PolicyView({ t, initialSel, data, error }) {
  const [sel, setSel] = useState(initialSel ?? null)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(null)

  useEffect(() => {
    if (!sel) return
    setDetailLoading(true)
    setDetailError(null)
    setDetail(null)
    fetch(`/api/iam/policy?account=${encodeURIComponent(sel.account)}&arn=${encodeURIComponent(sel.arn)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setDetail)
      .catch((e) => setDetailError(e.message))
      .finally(() => setDetailLoading(false))
  }, [sel])

  const accounts = data?.accounts ?? []
  const hasAny = accounts.some((a) => (a.policies ?? []).length || a.error)

  if (error) return <div className="ui-readwarn">{error}</div>
  if (data && !hasAny) return <Lista vuoto={t('iam.none')}>{[]}</Lista>

  return (
    <div className="ui-hero" style={{ '--ui-hero-cols': 'minmax(0, 1fr) minmax(0, 1.6fr)', alignItems: 'start' }}>
      <div>
        {accounts.map((a) => (
          <Sezione key={a.account} titolo={a.label}>
            {a.error ? (
              <div className="ui-readwarn">{a.error}</div>
            ) : (
              <Lista griglia="minmax(0, 1fr) auto" grigliaMobile="minmax(0, 1fr) auto">
                {(a.policies ?? []).map((p) => (
                  <button
                    key={p.arn}
                    type="button"
                    className="ui-row ui-row-btn"
                    aria-pressed={sel?.arn === p.arn}
                    style={{ background: sel?.arn === p.arn ? 'var(--brand-soft)' : undefined }}
                    onClick={() => setSel({ account: a.account, arn: p.arn })}
                  >
                    <span className="ui-name">{p.name}</span>
                    <span className="ui-when">{t('iam.attachments', { n: p.attachments })}</span>
                  </button>
                ))}
              </Lista>
            )}
          </Sezione>
        ))}
      </div>

      <div>
        {!sel ? (
          <Lista vuoto={t('iam.pick')}>{[]}</Lista>
        ) : detailLoading ? (
          <Loading text={t('iam.loading')} />
        ) : detailError ? (
          <div className="ui-readwarn">{detailError}</div>
        ) : detail ? (
          <>
            <Card titolo={t('iam.policy')}>
              <b style={{ fontSize: 16 }}>{detail.name}</b>
              {detail.description && <span className="ui-mute">{detail.description}</span>}
            </Card>
            <Sezione titolo={t('iam.whoHasIt')}>
              <Entities entities={detail.entities} t={t} />
            </Sezione>
            <Sezione titolo={t('iam.grants')}>
              <Lista griglia="minmax(0, 1fr)" grigliaMobile="minmax(0, 1fr)" vuoto={t('iam.noGrants')}>
                {detail.statements.map((st, i) => (
                  <div key={i} className="ui-row">
                    <ActionTags actions={st.actions} />
                    {st.resources.map((r, j) => (
                      <span key={j} className="ui-hint ui-mono" style={{ wordBreak: 'break-all' }}>
                        {r}
                      </span>
                    ))}
                  </div>
                ))}
              </Lista>
            </Sezione>
          </>
        ) : null}
      </div>
    </div>
  )
}

// --- Vista "Per risorsa": scegli un servizio → quali policy lo toccano, chi le usa, con quali azioni. ---
function ResourceView({ services, t, initialResource }) {
  const [resource, setResource] = useState(initialResource ?? null) // `${accountKey}|${name}`
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [principal, setPrincipal] = useState(null) // filtro: mostra solo gli accessi che coinvolgono questo gruppo/persona

  const options = useMemo(() => {
    const base = services.map((s) => ({
      value: `${s.account?.key ?? '__none__'}|${s.name}`,
      label: `${s.name}${s.type ? ` · ${s.type}` : ''}`,
    }))
    // se arriviamo da un link su una risorsa che non è un servizio monitorato (es. un secret),
    // aggiungiamo comunque l'opzione così il Select mostra la selezione.
    if (resource && !base.some((o) => o.value === resource))
      base.unshift({ value: resource, label: resource.slice(resource.indexOf('|') + 1) })
    return base
  }, [services, resource])

  useEffect(() => {
    if (!resource) return
    const sep = resource.indexOf('|')
    const account = resource.slice(0, sep)
    const needle = resource.slice(sep + 1)
    setLoading(true)
    setError(null)
    setData(null)
    setPrincipal(null) // cambia risorsa → azzera il filtro per gruppo/persona (i principal cambiano)
    fetch(`/api/iam/access?account=${encodeURIComponent(account)}&needle=${encodeURIComponent(needle)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [resource])

  // Tutti i "chi" che compaiono: ruoli/utenti/gruppi (lato policy) + assegnazioni SSO + membri dei
  // gruppi assegnati. Popola il filtro "per gruppo/persona".
  const rawMatches = data?.matches ?? []
  const rawSso = data?.ssoMatches ?? []
  const principals = useMemo(() => {
    const s = new Set()
    for (const m of rawMatches) {
      for (const arr of [m.entities.roles, m.entities.users, m.entities.groups]) arr.forEach((x) => s.add(x))
    }
    for (const m of rawSso) for (const a of m.assignments) {
      s.add(a.name)
      ;(a.members ?? []).forEach((x) => s.add(x))
    }
    return [...s].sort((a, b) => a.localeCompare(b))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // Un accesso "coinvolge" il principal se lo nomina tra ruoli/utenti/gruppi (policy) o tra le
  // assegnazioni SSO, incluso il caso in cui la persona è MEMBRO di un gruppo assegnato.
  const matches = principal
    ? rawMatches.filter((m) => [m.entities.roles, m.entities.users, m.entities.groups].some((a) => a.includes(principal)))
    : rawMatches
  const ssoMatches = principal
    ? rawSso.filter((m) => m.assignments.some((a) => a.name === principal || (a.members ?? []).includes(principal)))
    : rawSso

  // Una card per accesso trovato: il nome della policy o del permission set, la pillola «ampio» quando
  // concede `*`, chi la usa e cosa concede. Le due provenienze hanno la stessa forma apposta, cosi'
  // la differenza che si legge e' quella che conta (policy o SSO) e non il disegno.
  const accesso = (titolo, broad, chi, actions, key) => (
    <Card key={key} titolo={titolo} nota={broad ? <Pill livello="warn">{t('iam.broadGrant')}</Pill> : null}>
      {chi}
      <ActionTags actions={actions} />
    </Card>
  )

  return (
    <>
      {/* Due campi scritti a mano invece di due select: l'elenco dei servizi e' lungo, e il datalist
          del browser filtra mentre si scrive, che era la sola ragione per cui serviva un componente. */}
      <div className="ui-row" style={{ ...stileGriglia('minmax(0, 1fr) minmax(0, 1fr)', 'minmax(0, 1fr)'), padding: 0, border: 0 }}>
        <select className="ui-campo" value={resource ?? ''} onChange={(e) => setResource(e.target.value || null)} aria-label={t('iam.pickResource')}>
          <option value="">{t('iam.pickResource')}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {principals.length > 0 && (
          <select className="ui-campo" value={principal ?? ''} onChange={(e) => setPrincipal(e.target.value || null)} aria-label={t('iam.pickPrincipal')}>
            <option value="">{t('iam.pickPrincipal')}</option>
            {principals.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="ui-note">{t('iam.resourceHeuristic')}</p>
      {loading && <Loading text={t('iam.loading')} />}
      {error && <div className="ui-readwarn">{error}</div>}
      {data && matches.length === 0 && ssoMatches.length === 0 && (
        <Lista vuoto={principal ? t('iam.noAccessFor', { p: principal }) : t('iam.noAccess')}>{[]}</Lista>
      )}

      {matches.length > 0 && (
        <Sezione titolo={t('iam.viaPolicy')}>
          <div className="ui-envgrid" style={{ alignItems: 'start' }}>
            {matches.map((m) => accesso(m.policy, m.broad, <Entities entities={m.entities} t={t} />, m.actions, m.arn))}
          </div>
        </Sezione>
      )}

      {ssoMatches.length > 0 && (
        <Sezione titolo={t('iam.viaSso')}>
          <div className="ui-envgrid" style={{ alignItems: 'start' }}>
            {ssoMatches.map((m, i) => accesso(m.permissionSet, m.broad, <Assignments items={m.assignments} t={t} />, m.actions, i))}
          </div>
        </Sezione>
      )}
    </>
  )
}

// --- Vista "Accesso SSO": Identity Center → permission set → utenti/gruppi assegnati, per account.
// È il modo reale in cui gli umani hanno accesso (non IAM user/group). ---
function SsoView({ t, data, error }) {
  if (error) return <div className="ui-readwarn">{error}</div>
  if (data && !data.available) return <Lista vuoto={t('iam.ssoNone')}>{[]}</Lista>
  const ps = data?.permissionSets ?? []
  if (ps.length === 0) return <Lista vuoto={t('iam.ssoEmpty')}>{[]}</Lista>

  return (
    <>
      <p className="ui-note">{t('iam.ssoDesc')}</p>
      <div className="ui-envgrid" style={{ alignItems: 'start' }}>
        {ps.map((p) => (
          <Card key={p.name} titolo={p.name} nota={t('iam.assegnazioni', { n: p.assignments.length })}>
            <Assignments items={p.assignments} t={t} />
          </Card>
        ))}
      </div>
    </>
  )
}

// Pagina Permessi (IAM): fino a tre lenti, ma mostriamo solo quelle che hanno senso per QUESTO account AWS.
// "Accesso SSO" = come gli umani hanno accesso davvero (Identity Center); appare solo se c'è un'istanza
// Identity Center. "Per risorsa" = da una risorsa a chi ci accede; appare se ci sono servizi/risorse.
// "Per policy" = da una customer-managed policy a chi la usa e cosa concede; appare solo se l'account ha
// davvero delle policy custom (chi usa solo SSO + policy AWS-managed non ne ha, e la lente resta nascosta).
// I dati di SSO e policy si caricano qui una volta sola e si passano alle viste. Sola lettura, on-demand.
export default function IamPage({ services = [], t = (k) => k, lang }) {
  const [params] = useSearchParams()
  const paramView = params.get('view')
  const [sso, setSso] = useState({ loading: true })
  const [policies, setPolicies] = useState({ loading: true })
  const [view, setView] = useState(null)

  useEffect(() => {
    fetch('/api/iam/sso')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setSso({ data: d }))
      .catch((e) => setSso({ error: e.message }))
    fetch(`/api/iam/policies?lang=${lang}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setPolicies({ data: d }))
      .catch((e) => setPolicies({ error: e.message }))
  }, [lang])

  const settled = !sso.loading && !policies.loading
  const hasSso = !!sso.data?.available
  const hasPolicies = (policies.data?.accounts ?? []).some((a) => (a.policies ?? []).length > 0)
  const hasResources = services.length > 0
  const lenses = useMemo(
    () =>
      [
        hasSso && { label: t('iam.bySso'), value: 'sso' },
        hasResources && { label: t('iam.byResource'), value: 'resource' },
        hasPolicies && { label: t('iam.byPolicy'), value: 'policy' },
      ].filter(Boolean),
    [hasSso, hasResources, hasPolicies, t],
  )

  // Fissa la vista di default appena si conoscono le lenti disponibili (rispetta ?view= se valido).
  useEffect(() => {
    if (!settled || view) return
    const avail = lenses.map((l) => l.value)
    setView((avail.includes(paramView) && paramView) || avail[0] || 'none')
  }, [settled, view, lenses, paramView])

  // preselezione quando si arriva da un link della pagina Sicurezza
  const initialSel = paramView === 'policy' && params.get('arn') ? { account: params.get('account'), arn: params.get('arn') } : null
  const initialResource =
    paramView === 'resource' && params.get('needle') ? `${params.get('account')}|${params.get('needle')}` : null

  const intro = <Verdetto resto={t('iam.title')} dettaglio={t('iam.desc')} />

  if (!settled || !view)
    return (
      <div className="ui-pagina">
        {intro}
        <Loading text={t('iam.loading')} />
      </div>
    )

  if (view === 'none')
    return (
      <div className="ui-pagina">
        {intro}
        <Lista vuoto={t('iam.nothing')}>{[]}</Lista>
      </div>
    )

  return (
    <div className="ui-pagina">
      {intro}
      {lenses.length > 1 && <Tabs voci={lenses.map((l) => ({ key: l.value, label: l.label }))} attiva={view} onCambia={setView} />}
      {view === 'policy' ? (
        <PolicyView t={t} initialSel={initialSel} data={policies.data} error={policies.error} />
      ) : view === 'resource' ? (
        <ResourceView services={services} t={t} initialResource={initialResource} />
      ) : (
        <SsoView t={t} data={sso.data} error={sso.error} />
      )}
    </div>
  )
}
