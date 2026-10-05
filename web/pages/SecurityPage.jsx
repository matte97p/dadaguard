import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Verdetto, Tabs, Lista, Sezione, RigaProblema } from '../ui/index.js'
import WafPanel from '../components/WafPanel.jsx'
import Loading from '../components/Loading.jsx'
import './ops.css'

// La severita' del server tradotta nei livelli della nuova interfaccia: rosso solo per quello che va
// fatto oggi, arancio per il resto da sistemare, blu per l'igiene che si guarda quando c'e' tempo.
const LIVELLO = { high: 'crit', medium: 'warn', low: 'info', info: 'info' }
const RANGO = { crit: 0, warn: 1, info: 2 }

// La casellina accanto al nome: dice DA DOVE arriva la riga prima di leggerla, come nella home.
const SIGLA = { public: 'NET', expiring: 'TLS', secret: 'KEY', iam: 'IAM', database: 'DB', compute: 'CPU', deploy: 'CI', llms: 'AI' }

// Pagina Sicurezza: findings di sicurezza/governance aggregati (superficie pubblica, scadenze,
// secret stantii, igiene IAM…), filtrabili per categoria e ordinati per severità, e sopra il
// traffico fermato dal WAF. Sola lettura.
export default function SecurityPage({ t = (k) => k, lang }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [cat, setCat] = useState('all')
  const navigate = useNavigate()

  // Alcuni finding rimandano alla pagina Permessi: una policy troppo larga alla sua vista "per policy",
  // una risorsa esposta / un secret alla vista "per risorsa" (chi ci accede).
  const openLink = (link) => {
    const p = new URLSearchParams({ view: link.view, account: link.account ?? '' })
    if (link.arn) p.set('arn', link.arn)
    if (link.needle) p.set('needle', link.needle)
    navigate(`/iam?${p.toString()}`)
  }

  // `lang` nella query e nelle dipendenze: i `detail` dei finding sono frasi costruite dal server,
  // quindi cambiando lingua vanno richiesti di nuovo, non si traducono nel browser.
  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/security?lang=${lang ?? ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [lang])

  // Ordinati dal piu' grave: in un elenco lungo si guarda la prima riga, non la settima. `sort` e'
  // stabile, quindi a parita' di livello resta l'ordine del server.
  const findings = useMemo(
    () => [...(data?.findings ?? [])].sort((a, b) => (RANGO[LIVELLO[a.severity]] ?? 3) - (RANGO[LIVELLO[b.severity]] ?? 3)),
    [data],
  )
  const categories = useMemo(() => [...new Set(findings.map((f) => f.category))], [findings])
  const shown = cat === 'all' ? findings : findings.filter((f) => f.category === cat)
  const gravi = findings.filter((f) => LIVELLO[f.severity] === 'crit').length
  const voci = [
    { key: 'all', label: t('sec.all'), n: findings.length },
    ...categories.map((c) => ({ key: c, label: t(`sec.cat.${c}`), n: findings.filter((f) => f.category === c).length })),
  ]

  // Il verdetto: «quante cose di sicurezza sono aperte». Zero e' una risposta e va detta come tale,
  // non come uno stato vuoto: la pagina che non dice niente si legge come «non lo so».
  const verdetto = !data ? (
    <Verdetto resto={t('sec.title')} dettaglio={t('sec.desc')} />
  ) : findings.length === 0 ? (
    <Verdetto livello="ok" forte={t('sec.v.okTitolo')} dettaglio={t('sec.none')} />
  ) : (
    <Verdetto
      livello={gravi ? 'crit' : 'warn'}
      forte={gravi ? t('sec.v.graviN', { n: gravi }) : t('sec.v.titolo', { n: findings.length })}
      resto={gravi ? ` ${t('sec.v.suTotale', { n: findings.length })}` : null}
      dettaglio={t('sec.v.dettaglio', { n: categories.length })}
    />
  )

  return (
    <div className="ui-pagina">
      {verdetto}
      {/* Il WAF sta in cima e non fra i finding: non è un'igiene da sistemare quando c'è tempo, è
          traffico che in questo momento non arriva ai servizi. */}
      <WafPanel t={t} />
      {loading && <Loading text={t('sec.loading')} />}
      {error && <div className="ui-readwarn">{error}</div>}
      {data && findings.length > 0 && (
        <Sezione titolo={t('sec.daSistemare')} sotto={t('sec.dalPiuGrave')}>
          {categories.length > 1 && <Tabs voci={voci} attiva={cat} onCambia={setCat} />}
          <Lista vuoto={t('sec.none')}>
            {shown.map((f, i) => (
              <RigaProblema
                key={`${f.category}:${f.resource}:${i}`}
                livello={LIVELLO[f.severity] ?? 'info'}
                etichetta={t(`sec.sev.${f.severity}`)}
                icona={SIGLA[f.category] ?? '!'}
                nome={f.resource}
                sotto={[t(`sec.cat.${f.category}`), f.accountLabel].filter(Boolean).join(' · ')}
                cosa={f.detail}
                azione={f.link ? t('sec.openIam') : null}
                onApri={f.link ? () => openLink(f.link) : undefined}
              />
            ))}
          </Lista>
        </Sezione>
      )}
      <p className="ui-note">{t('sec.nota')}</p>
    </div>
  )
}
