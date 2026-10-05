import Pill from './Pill.jsx'
import Sparkline from './Sparkline.jsx'

// Una riga di «Da sistemare»: stato, cosa, perche', di chi e', andamento, e l'invito ad aprirla.
// E' un bottone solo se porta da qualche parte: una riga che sembra cliccabile e non fa niente
// insegna a non cliccare le altre.
// `rest` porta le ancore `data-*` (le usa il video demo, demowright.story.js): niente altro passa di qui.
export default function RigaProblema({ livello, etichetta, icona, nome, sotto, cosa, suggerimento, owner, serie, quando, azione, onApri, ...rest }) {
  const Tag = onApri ? 'button' : 'div'
  return (
    <Tag type={onApri ? 'button' : undefined} className={`ui-row ui-row-problema ${onApri ? 'ui-row-btn' : ''}`} onClick={onApri} {...rest}>
      <Pill livello={livello}>{etichetta}</Pill>
      <span className="ui-nm">
        {icona && <span className="ui-kicon">{icona}</span>}
        <span className="ui-name">
          {nome}
          {sotto && <small>{sotto}</small>}
        </span>
      </span>
      <span className="ui-what">
        {cosa}
        {suggerimento && <span className="ui-hint">{suggerimento}</span>}
      </span>
      <span className="ui-who">{owner && <b>{owner}</b>}</span>
      {serie?.length > 1 ? <Sparkline valori={serie} livello={livello} className="ui-sk" /> : <span className="ui-sk ui-when">{quando}</span>}
      <span className="ui-go">{azione}</span>
    </Tag>
  )
}
