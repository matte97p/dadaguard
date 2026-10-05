import { useState } from 'react'
import { Lista, Pill, Meter, Drawer, Rimedio, BloccoComando, ListaLink } from '../ui/index.js'
import { livelloTetto } from './spesaKit.js'

const GRIGLIA = '96px minmax(0,1.3fr) minmax(0,1.6fr) 60px'
// Sul telefono: stato, offerta e percentuale in testa, la barra sotto.
const GRIGLIA_M = 'auto minmax(0,1fr) auto'
const unita = (it) => (it.unit ? ` ${it.unit}` : '')

// Scheda Free Tier: uso mensile contro il limite gratuito, per offerta (es. CodeBuild 100 minuti).
// Dato di tutta l'organizzazione, letto dal payer. Verde sotto l'85%, arancio fino al 100%, rosso
// oltre: sopra il limite quel consumo si paga.
export default function FreeTierPage({ t = (k) => k, risposta }) {
  const [aperta, setAperta] = useState(null)
  if (!risposta) return <p className="ui-mute">{t('freetier.loading')}</p>
  const errore = risposta.errore ?? risposta.dati?.error
  if (errore) return <Rimedio livello="warn" titolo={t('lim.f.errore')} testo={errore} t={t} />
  const items = [...(risposta.dati?.items ?? [])].sort((a, b) => b.pct - a.pct)

  return (
    <>
      <p className="ui-mute" style={{ margin: 0 }}>
        {t('freetier.desc')}
      </p>
      <Lista colonne={[t('spend.col.stato'), t('lim.col.offerta'), t('lim.col.uso'), '']} griglia={GRIGLIA} grigliaMobile={GRIGLIA_M} vuoto={t('freetier.none')}>
        {items.map((it, i) => {
          const livello = livelloTetto(it.pct, 100, 85)
          return (
            <button
              key={`${it.service}/${it.usageType}/${i}`}
              type="button"
              className="ui-row ui-row-btn"
              onClick={() => setAperta(it)}
            >
              <Pill livello={livello}>{t(`lim.f.livello.${livello}`)}</Pill>
              <span className="ui-name">
                {it.service}
                {it.usageType && <small>{it.usageType}</small>}
              </span>
              <span className="ui-what">
                <Meter valore={it.pct} livello={livello} />
                <span className="ui-hint">
                  {it.used.toLocaleString(undefined, { maximumFractionDigits: 1 })} / {it.limit.toLocaleString()}
                  {unita(it)}
                  {it.forecast > 0 ? ` · ${t('freetier.forecast')} ${Math.round(it.forecast).toLocaleString()}${unita(it)}` : ''}
                </span>
              </span>
              <b className="sp-num">{it.pct}%</b>
            </button>
          )
        })}
      </Lista>

      <Drawer aperto={Boolean(aperta)} onChiudi={() => setAperta(null)} titolo={aperta?.service} sotto={aperta?.usageType} etichettaChiudi={t('ui.chiudi')}>
        {aperta && (
          <>
            <div className="ui-stats">
              <div className="ui-stat">
                <b className={`ui-t-${livelloTetto(aperta.pct, 100, 85)}`}>{aperta.pct}%</b>
                <span>{t('lim.f.usato')}</span>
              </div>
              <div className="ui-stat">
                <b className="ui-mono">{aperta.forecast > 0 ? `${Math.round(aperta.forecast).toLocaleString()}${unita(aperta)}` : '-'}</b>
                <span>{t('freetier.forecast')}</span>
              </div>
            </div>
            {aperta.pct >= 85 && (
              <Rimedio
                livello={livelloTetto(aperta.pct, 100, 85)}
                titolo={t('spend.cosaFare')}
                testo={aperta.pct >= 100 ? t('freetier.v.oltre') : t('freetier.v.vicine')}
                t={t}
              />
            )}
            <BloccoComando comando="aws freetier get-free-tier-usage --region us-east-1" t={t} />
            <ListaLink link={[{ label: t('lim.link.free'), href: 'https://console.aws.amazon.com/billing/home#/freetier' }]} />
          </>
        )}
      </Drawer>
    </>
  )
}
