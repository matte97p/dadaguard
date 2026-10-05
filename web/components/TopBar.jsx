import { useEffect, useState } from 'react'
import { Dot } from '../ui/index.js'

// Barra in alto: dove sono (ambiente), chi sono (Sviluppo o DevOps), e quanto sono freschi i dati.
//
// L'ambiente e' una fila di pillole e non un menu a tendina perche' gli ambienti sono pochi e il
// pallino di ognuno e' un'informazione: si vede che Staging e' rosso senza aprire niente.
//
// Le azioni di servizio (lingua, tema, connessione agli account, verifica completa, scoperta) stanno
// a destra e piccole: si usano di rado, e non devono competere con le tre cose che si guardano sempre.
export default function TopBar({
  ambienti = [],
  ambiente,
  onAmbiente,
  ruolo,
  onRuolo,
  onCerca,
  aggiornato,
  inCorso,
  onAggiorna,
  dark,
  onDark,
  lang,
  onLang,
  salute,
  onSalute,
  azioni = [],
  onHome,
  t = (k) => k,
}) {
  return (
    <div className="ui-top">
      <button type="button" className="ui-logo" onClick={onHome} title={t('app.subtitle')}>
        <i>D</i>Dadaguard
      </button>
      <div className="ui-envs" role="group" aria-label={t('shell.ambiente')}>
        <button type="button" className="ui-env" aria-pressed={ambiente == null} onClick={() => onAmbiente(null)}>
          <Dot livello={ambienti.reduce((p, a) => (rank(a.livello) < rank(p) ? a.livello : p), 'off')} />
          {t('shell.tutti')}
        </button>
        {ambienti.map((a) => (
          <button key={a.key} type="button" className="ui-env" aria-pressed={ambiente === a.key} onClick={() => onAmbiente(a.key)}>
            <Dot livello={a.livello} />
            {a.label}
          </button>
        ))}
      </div>
      <div className="ui-sp" />
      <div className="ui-seg" role="group" aria-label={t('shell.chiSei')}>
        <button type="button" data-ruolo="dev" aria-pressed={ruolo === 'dev'} onClick={() => onRuolo('dev')}>
          {t('shell.ruolo.dev')}
        </button>
        <button type="button" data-ruolo="ops" aria-pressed={ruolo === 'ops'} onClick={() => onRuolo('ops')}>
          {t('shell.ruolo.ops')}
        </button>
      </div>
      <button type="button" className="ui-kbd" data-view="cerca" onClick={onCerca}>
        {t('shell.cerca')}&nbsp;&nbsp;⌘K
      </button>
      <Freschezza aggiornato={aggiornato} inCorso={inCorso} onAggiorna={onAggiorna} t={t} />
      <span style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
        {azioni.map((a) => (
          <button key={a.key} type="button" className="ui-icon-btn" onClick={a.onClick} title={a.title}>
            {a.label}
          </button>
        ))}
        <button type="button" className="ui-icon-btn" onClick={onSalute} title={t('health.title')}>
          <Dot livello={salute === 'up' ? 'ok' : salute === 'down' ? 'crit' : 'off'} /> AWS
        </button>
        <button type="button" className="ui-icon-btn" onClick={() => onLang(lang === 'it' ? 'en' : 'it')} title={t('shell.lingua')}>
          {lang === 'it' ? 'EN' : 'IT'}
        </button>
        <button type="button" className="ui-icon-btn" onClick={onDark} title={dark ? t('btn.themeLight') : t('btn.themeDark')} aria-label={dark ? t('btn.themeLight') : t('btn.themeDark')}>
          {dark ? '☀' : '☾'}
        </button>
      </span>
    </div>
  )
}

const RANGO = { crit: 0, warn: 1, info: 2, ok: 3, off: 4 }
const rank = (l) => RANGO[l] ?? 5

// «aggiornato 12 s fa», che scorre da solo. E' anche il bottone per aggiornare: chi guarda l'eta' dei
// dati e la trova vecchia vuole rinfrescarli, e il gesto naturale e' cliccare proprio li'.
function Freschezza({ aggiornato, inCorso, onAggiorna, t }) {
  const [, forza] = useState(0)
  useEffect(() => {
    const id = setInterval(() => forza((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])
  let testo = t('poll.updating')
  if (!inCorso && aggiornato) {
    const s = Math.max(0, Math.round((Date.now() - aggiornato) / 1000))
    testo = s < 5 ? t('poll.justNow') : s < 60 ? t('poll.secAgo', { s }) : t('poll.minAgo', { m: Math.floor(s / 60) })
  }
  return (
    <button type="button" className="ui-fresh" onClick={onAggiorna} title={t('btn.refresh')}>
      <Dot livello={inCorso ? 'info' : aggiornato ? 'ok' : 'off'} />
      {testo}
    </button>
  )
}
