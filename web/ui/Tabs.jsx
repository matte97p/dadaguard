// Schede sottili con conteggio facoltativo. `voci`: [{ key, label, n }]. Il conteggio sta sulla
// scheda perche' dice dove guardare prima di aprirla.
export default function Tabs({ voci = [], attiva, onCambia }) {
  const corrente = attiva ?? voci[0]?.key
  return (
    <div className="ui-tabs" role="tablist">
      {voci.map((v) => (
        <button key={v.key} type="button" role="tab" data-tab={v.key} aria-selected={corrente === v.key} aria-pressed={corrente === v.key} onClick={() => onCambia?.(v.key)}>
          {v.label}
          {v.n != null && <span>{v.n}</span>}
        </button>
      ))}
    </div>
  )
}
