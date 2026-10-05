import { useEffect, useState } from 'react'
import { Card, Lista, Meter, Pill, Sezione } from '../ui/index.js'

// Riga di una regola, su due livelli: azione + dove si aggiusta + quante richieste ha preso, e sotto
// i percorsi colpiti, che sono la cosa che dice se il blocco è sbagliato (`/api/v1/tenders` non è
// traffico da bot). I percorsi vanno a capo perché sono lunghi: comprimerli in coda alla prima riga
// li troncava proprio nel punto che distingue una rotta dall'altra. La barra e' relativa alla regola
// che ferma di piu' nella zona: dice a colpo d'occhio quale guardare, il numero vero sta accanto.
// Sul telefono: azione, barra e numero in testa, la regola e i percorsi sotto a tutta riga.
const GRIGLIA_REGOLE = '96px minmax(0, 1.6fr) minmax(0, 1fr) 72px'
const GRIGLIA_REGOLE_M = 'auto minmax(0, 1fr) auto'

function RuleRow({ r, max, t }) {
  return (
    <div className="ui-row">
      <Pill livello={r.blocking ? 'crit' : 'off'}>{r.action}</Pill>
      <span className="ui-what">
        {t(`waf.source.${r.sourceKind}`)}
        {r.ruleId && (
          <small className="ui-mono ui-faint" title={r.ruleId}>
            {' '}
            {r.ruleId.length > 12 ? `${r.ruleId.slice(0, 12)}…` : r.ruleId}
          </small>
        )}
        {r.paths?.length > 0 && <span className="ui-hint ui-mono" style={{ wordBreak: 'break-all' }}>{r.paths.join(' · ')}</span>}
      </span>
      <Meter valore={max ? (r.count / max) * 100 : 0} livello={r.blocking ? 'brand' : 'off'} />
      <b className="ui-mono" style={{ textAlign: 'right' }}>
        {r.count.toLocaleString()}
      </b>
    </div>
  )
}

function ZoneCard({ z, t }) {
  if (z.error) {
    return (
      <Card titolo={z.zone}>
        <div className="ui-readwarn">{z.error}</div>
      </Card>
    )
  }
  const max = Math.max(0, ...(z.rules ?? []).map((r) => r.count))
  return (
    // data-view: ancora per il video demo, vedi pageKit.jsx.
    <Card data-view="waf" titolo={z.zone}>
      {/* Le due cifre stanno vicine e NON si sommano, ed è il punto: mettere una regola in `log` non
          impedisce a un'altra di bloccare. La nota sotto lo dice per intero. */}
      <div className="ui-stats">
        <div className="ui-stat">
          <b className={z.blocked ? 'ui-t-crit' : undefined}>{z.blocked.toLocaleString()}</b>
          <span>{t('waf.blocked')}</span>
        </div>
        <div className="ui-stat" title={t('waf.loggedHint')}>
          <b className="ui-mute">{z.logged.toLocaleString()}</b>
          <span>{t('waf.logged')}</span>
        </div>
      </div>
      <span className="ui-faint" style={{ fontSize: 12.5 }}>
        {t('waf.nonSiSommano')}
      </span>
      {z.rules?.length > 0 && (
        <Lista griglia={GRIGLIA_REGOLE} grigliaMobile={GRIGLIA_REGOLE_M}>
          {z.rules.map((r, i) => (
            <RuleRow key={`${r.ruleId}:${r.action}:${i}`} r={r} max={max} t={t} />
          ))}
        </Lista>
      )}
    </Card>
  )
}

// Pannello WAF: quanto traffico il firewall ha FERMATO nella finestra, per zona e per regola.
// Sta nella pagina Sicurezza perché è l'unico posto dove un blocco sbagliato si vede: quel traffico
// non raggiunge i servizi, quindi non esiste in nessun log applicativo né in nessuna metrica ECS.
//
// Una card per zona, affiancate: su uno schermo grande il nome della zona e il suo conteggio a piena
// larghezza finivano ai due estremi della riga, e due numeri che vanno letti INSIEME non si possono
// mettere così lontani.
export default function WafPanel({ t = (k) => k }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  // `alive`: le schede di «Spesa»/«Sicurezza» distruggono il pane inattivo, quindi questo pannello
  // può smontarsi mentre la richiesta è in volo, e allora la risposta non deve toccare più niente.
  useEffect(() => {
    let alive = true
    fetch('/api/waf')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => alive && setData(j))
      .catch((e) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [])

  // Integrazione spenta (nessun token Cloudflare): nessuna sezione, nessun rumore.
  if (!data || data.disabled) return error ? <div className="ui-readwarn">{error}</div> : null

  const zones = data.zones ?? []
  // Le zone senza dataset (domini parcheggiati su piano Free) NON sono un guasto e non diventano card:
  // erano otto riquadri d'allarme con lo stesso errore Cloudflare per intero, e coprivano le due zone
  // dove il traffico viene davvero fermato. Restano una riga, perché "non lo so" ≠ "non è successo".
  const noDataset = zones.filter((z) => z.noDataset)
  const queryable = zones.filter((z) => !z.noDataset)
  const hit = queryable.filter((z) => z.error || (z.blocked ?? 0) > 0)
  const clean = queryable.length - hit.length

  return (
    <Sezione titolo={t('waf.title', { h: data.hours })} sotto={t('waf.desc')}>
      {data.error && <div className="ui-readwarn">{data.error}</div>}
      {hit.length === 0 && !data.error && (
        <Lista vuoto={t('waf.noBlocks')}>{[]}</Lista>
      )}
      {hit.length > 0 && (
        <div className="ui-hero">
          {hit.map((z) => (
            <ZoneCard key={z.zoneId ?? z.zone} z={z} t={t} />
          ))}
        </div>
      )}
      {clean > 0 && hit.length > 0 && <p className="ui-note">{t('waf.zonesClean', { n: clean })}</p>}
      {noDataset.length > 0 && (
        <p className="ui-note">
          {t('waf.zonesNoDataset', { n: noDataset.length })}{' '}
          <span className="ui-mono">{noDataset.map((z) => z.zone).join(' · ')}</span>
        </p>
      )}
    </Sezione>
  )
}
