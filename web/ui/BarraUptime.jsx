// Barra della disponibilita': una tacca per fascia di tempo, colorata col livello di quella fascia.
// Le fasce `off` sono quelle che non conosciamo, e restano grigie apposta: un passato verde inventato
// e' peggio di un buco dichiarato.
export default function BarraUptime({ fasce = [], altezza = 22, etichette, titolo }) {
  return (
    <div className="ui-uptime-wrap" title={titolo}>
      <div className="ui-uptime" style={{ height: altezza }}>
        {fasce.map((l, i) => (
          <i key={i} className={`ui-${l}`} />
        ))}
      </div>
      {etichette && (
        <div className="ui-axis">
          {etichette.map((e, i) => (
            <span key={i}>{e}</span>
          ))}
        </div>
      )}
    </div>
  )
}
