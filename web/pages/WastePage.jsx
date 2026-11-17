import { useState } from 'react'
import { Lista, Sezione, Pill, Drawer, Rimedio, ListaLink, BloccoComando } from '../ui/index.js'
import { soldi } from './spesaKit.js'
import { comandoAws, linkAws } from '../../shared/accessoAws.js'
import { accessoPer } from '../accesso.js'
import { buildItems, ORDINE, PILL, RIMEDIO } from './wasteKit.js'

export { contaSprechi } from './wasteKit.js'

// Dove si guarda una risorsa ferma in console. La regione si mette se il server la manda; senza, la
// console apre quella in cui eri l'ultima volta, che e' quasi sempre quella giusta.
const CONSOLE = {
  eip: ['ec2', 'Addresses:'],
  nat: ['vpcconsole', 'NatGateways:'],
  ebs: ['ec2', 'Volumes:'],
  ec2: ['ec2', 'Instances:'],
  rds: ['rds', 'databases:'],
  ec2Standby: ['ec2', 'Instances:'],
  rdsStandby: ['rds', 'databases:'],
}
const linkConsole = (key, region) => {
  const c = CONSOLE[key]
  if (!c) return null
  return region
    ? `https://${region}.console.aws.amazon.com/${c[0]}/home?region=${region}#${c[1]}`
    : `https://console.aws.amazon.com/${c[0]}/home#${c[1]}`
}

const GRIGLIA = '110px minmax(0,1fr) 140px'

// Scheda Sprechi: risorse a costo fisso che sembrano inutilizzate, per account. Una riga per voce,
// dal certo al da verificare, e il pannello con le risorse e il comando che le mostra.
//
// I dati arrivano da SpendPage (`risposta`), che li legge comunque per il numero sulla scheda.
export default function WastePage({ accountLabels, t = (k) => k, lang, risposta }) {
  const [aperta, setAperta] = useState(null)
  if (!risposta) return <p className="ui-mute">{t('spend.carico')}</p>
  const errore = risposta.errore ?? risposta.dati?.error
  if (errore) return <Rimedio livello="warn" titolo={t('spend.sprechi.errore')} testo={errore} t={t} />

  const entries = Object.entries(risposta.dati ?? {}).filter(([, v]) => !accountLabels || accountLabels.has(v.label))
  const total = entries.reduce((s, [, v]) => s + (v.estMonthlyUsd || 0), 0)
  const righe = entries
    .flatMap(([key, v]) => (v.error ? [] : buildItems(v, t).map((it) => ({ ...it, conto: v.label, contoChiave: key, region: v.region, chiave: `${key}/${it.key}` }))))
    .sort((a, b) => ORDINE[a.level] - ORDINE[b.level])
  const errori = entries.filter(([, v]) => v.error)

  return (
    <>
      <Sezione
        titolo={t('spend.sprechi.titolo')}
        sotto={total > 0 ? t('spend.sprechi.sotto', { v: soldi(total, lang) }) : t('waste.v.ok')}
      >
        <Lista colonne={[t('spend.col.stato'), t('spend.col.cosa'), t('spend.col.conto')]} griglia={GRIGLIA} vuoto={t('waste.v.okTitolo')}>
          {righe.map((r) => (
            <button
              key={r.chiave}
              type="button"
              className="ui-row ui-row-btn"
              onClick={() => setAperta(r)}
            >
              <Pill livello={PILL[r.level][0]}>{t(PILL[r.level][1])}</Pill>
              <span className="ui-what">
                {r.title}
                <span className="ui-hint">{r.names.map((n) => n.id).join(', ')}</span>
              </span>
              <span className="ui-mute">{r.conto}</span>
            </button>
          ))}
        </Lista>
        {errori.map(([key, v]) => (
          <p key={key} className="ui-note">
            {v.label}: {v.error}
          </p>
        ))}
      </Sezione>
      <p className="ui-note">{t('spend.sprechi.nota')}</p>

      <Drawer aperto={Boolean(aperta)} onChiudi={() => setAperta(null)} titolo={aperta?.title} sotto={aperta?.conto} etichettaChiudi={t('ui.chiudi')}>
        {aperta && (
          <>
            <p className="ui-mute">{aperta.reason}</p>
            <Lista griglia="minmax(0,1fr) auto" grigliaMobile="minmax(0,1fr) auto">
              {aperta.names.map((n) => (
                <div key={n.id} className="ui-row">
                  <span className="ui-mono" style={{ overflowWrap: 'anywhere' }}>
                    {n.id}
                  </span>
                  <span className="ui-mute">{n.meta}</span>
                </div>
              ))}
            </Lista>
            <Rimedio
              livello={aperta.level === 'spreco' ? 'warn' : undefined}
              titolo={t('spend.cosaFare')}
              testo={t(RIMEDIO[aperta.level])}
              t={t}
            />
            <BloccoComando
              comando={comandoAws(aperta.comando(aperta.names.map((n) => n.id)), accessoPer(aperta.contoChiave, aperta.conto), { region: aperta.region ?? null })}
              t={t}
            />
            <ListaLink
              link={[
                {
                  label: t('spend.link.console'),
                  href: linkAws(linkConsole(aperta.key, aperta.region), accessoPer(aperta.contoChiave, aperta.conto)),
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
