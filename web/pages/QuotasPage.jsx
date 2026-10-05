import { useState } from 'react'
import { Lista, Pill, Meter, Drawer, Rimedio, BloccoComando, ListaLink } from '../ui/index.js'
import { livelloTetto } from './spesaKit.js'

// Le quote di tutti gli account visibili in una lista sola, dalla più vicina al tetto: la domanda è
// «cosa sta per bloccarsi», e chiederla account per account la spezzava in tanti riquadri. Pura.
export function quoteVisibili(dati, accountLabels) {
  return (dati?.accounts ?? [])
    .filter((a) => !a.error && (!accountLabels || accountLabels.has(a.label)))
    .flatMap((a) => (a.quotas ?? []).map((q) => ({ ...q, conto: a.label })))
    .sort((x, y) => y.pct - x.pct)
}

const GRIGLIA = '96px minmax(0,1.3fr) 130px minmax(0,1.4fr) 56px'

// Scheda Quote: Service Quotas al ≥80% dell'uso (solo quelle con una metrica d'uso esposta).
// Oltre il 90% è rosso: lì la prossima risorsa può essere rifiutata, e l'aumento non è immediato.
export default function QuotasPage({ accountLabels, t = (k) => k, risposta }) {
  const [aperta, setAperta] = useState(null)
  if (!risposta) return <p className="ui-mute">{t('quotas.loading')}</p>
  if (risposta.errore) return <Rimedio livello="warn" titolo={t('lim.q.errore')} testo={risposta.errore} t={t} />
  const conti = (risposta.dati?.accounts ?? []).filter((a) => !accountLabels || accountLabels.has(a.label))
  if (!conti.length) return <p className="ui-vuoto">{t('quotas.noAccounts')}</p>
  const righe = quoteVisibili(risposta.dati, accountLabels)
  const errori = conti.filter((a) => a.error)

  return (
    <>
      <p className="ui-mute" style={{ margin: 0 }}>
        {t('quotas.desc')}
      </p>
      <Lista
        colonne={[t('spend.col.stato'), t('lim.col.quota'), t('spend.col.conto'), t('lim.col.uso'), '']}
        griglia={GRIGLIA}
        vuoto={t('quotas.v.okTitolo')}
      >
        {righe.map((q, i) => {
          const livello = livelloTetto(q.pct, 90, 80)
          return (
            <button
              key={`${q.conto}/${q.service}/${q.name}/${i}`}
              type="button"
              className="ui-row ui-row-btn"
              onClick={() => setAperta(q)}
            >
              <Pill livello={livello}>{t(`lim.livello.${livello}`)}</Pill>
              <span className="ui-name">
                {q.name}
                <small>{q.service}</small>
              </span>
              <span className="ui-mute">{q.conto}</span>
              <span className="ui-what">
                <Meter valore={q.pct} livello={livello} />
                <span className="ui-hint">
                  {Math.round(q.used).toLocaleString()} / {Number(q.limit).toLocaleString()}
                </span>
              </span>
              <b className="sp-num">{q.pct}%</b>
            </button>
          )
        })}
      </Lista>
      {errori.map((a) => (
        <p key={a.account ?? a.label} className="ui-note">
          {a.label}: {a.error}
        </p>
      ))}

      <Drawer aperto={Boolean(aperta)} onChiudi={() => setAperta(null)} titolo={aperta?.name} sotto={aperta ? `${aperta.service} · ${aperta.conto}` : null} etichettaChiudi={t('ui.chiudi')}>
        {aperta && (
          <>
            <div className="ui-stats">
              <div className="ui-stat">
                <b className={`ui-t-${livelloTetto(aperta.pct, 90, 80)}`}>{aperta.pct}%</b>
                <span>{t('lim.q.usata')}</span>
              </div>
              <div className="ui-stat">
                <b className="ui-mono">
                  {Math.round(aperta.used).toLocaleString()} / {Number(aperta.limit).toLocaleString()}
                </b>
                <span>{t('lim.q.usoLimite')}</span>
              </div>
            </div>
            <Rimedio livello={livelloTetto(aperta.pct, 90, 80)} titolo={t('spend.cosaFare')} testo={t('quotas.v.crit')} t={t} />
            {/* Il comando legge la quota com'è adesso: la richiesta di aumento si fa da console, dove
                AWS chiede il perché. */}
            <BloccoComando
              comando={`aws service-quotas list-service-quotas --service-code ${aperta.service} --query "Quotas[?QuotaName=='${String(aperta.name).replace(/'/g, "''")}']"`}
              t={t}
            />
            <ListaLink
              link={[
                {
                  label: t('lim.link.quote'),
                  href: `https://console.aws.amazon.com/servicequotas/home/services/${encodeURIComponent(aperta.service)}/quotas`,
                  nota: t('spend.link.nota', { conto: aperta.conto }),
                },
              ]}
            />
          </>
        )}
      </Drawer>
    </>
  )
}
