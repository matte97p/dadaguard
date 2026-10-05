import { Card, Pill } from '../ui/index.js'
import { livelloServizio, ownerServizio, teamServizio } from '../adattatori.js'
import { SIGLA, controlliDi, cosaSuccede } from '../servizi.js'
import { etichettaServizio, NomeServizio, tipoLabel, latenzaTesto } from './ServicesTable.jsx'
import './servizi.css'

// La card di un servizio, per chi preferisce la griglia alla lista. Dice le stesse cose della riga
// (stato, cosa succede, di chi, controlli, latenza) con le stesse regole, prese dagli stessi
// helper: due viste che dicono cose diverse sullo stesso servizio insegnano a non fidarsi di nessuna.
// Tutta la card apre il pannello, dove stanno log, eventi e cosa fare.
export default function ServiceCard({ service: s, famiglie, onOpen, t }) {
  const livello = livelloServizio(s)
  const controlli = controlliDi(s)
  const lat = latenzaTesto(s, t)
  return (
    <Card onClick={onOpen ? () => onOpen(s) : undefined} data-service={s.name}>
      <span className="sv-card-h">
        <Pill livello={livello}>{etichettaServizio(s, t)}</Pill>
        <span className="ui-kicon">{SIGLA[s.type] ?? '·'}</span>
      </span>
      <span className="ui-name">
        <NomeServizio s={s} famiglie={famiglie} t={t} />
        <small>{[tipoLabel(s.type, t), teamServizio(s) ?? t(`home.owner.${ownerServizio(s)}`)].filter(Boolean).join(' · ')}</small>
      </span>
      <span className="ui-what">{cosaSuccede(s) ?? <span className="ui-faint">{t('svc.nienteDaDire')}</span>}</span>
      <span className="sv-card-h">
        <span className="sv-checks">
          {controlli.map((c) => (
            <i
              key={c.chiave}
              className={`ui-bg-${c.livello}`}
              title={`${t(`svc.ck.${c.chiave}`)}: ${c.testo ?? t(`home.liv.${c.livello}`)}`}
            />
          ))}
        </span>
        {lat && <span className="ui-mono ui-mute">{lat}</span>}
      </span>
    </Card>
  )
}
