// Il verdetto in cima a ogni pagina: una frase sola che risponde «devo preoccuparmi?». La parte
// colorata e' la notizia, il resto la qualifica; la riga sotto spiega cosa si sta guardando.
export default function Verdetto({ livello, forte, resto, dettaglio, extra }) {
  return (
    <div className="ui-verdetto">
      <h1>
        {forte && <b className={livello ? `ui-t-${livello}` : undefined}>{forte}</b>}
        {resto}
      </h1>
      {dettaglio && <p>{dettaglio}</p>}
      {extra && <div className="ui-verdetto-extra">{extra}</div>}
    </div>
  )
}
