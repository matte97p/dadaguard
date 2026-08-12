import { Typography } from 'antd'
import { countByStatus } from '../format.js'
import { StatusGlyph } from './signals.jsx'

const { Text } = Typography

// Banda overview: quanti servizi, e quanti per stato — la risposta a "devo preoccuparmi?" prima di
// ordinare o filtrare niente. Ordine dal peggio (vedi countByStatus): l'occhio va subito lì.
//
// Ogni conteggio è anche un FILTRO, e usa quello che esiste già (`statusFilter` della barra), non un
// secondo meccanismo parallelo: due filtri per la stessa cosa si contraddicono a vicenda e non si
// capisce più quale sta agendo. Sono <button>: raggiungibili col tab, premibili con Invio,
// `aria-pressed` dice quale è attivo.
//
// I conteggi si calcolano SEMPRE sulla flotta intera (`all`), mai sul filtrato: se si restringessero
// alla selezione, filtrando "giù" la striscia direbbe "2 giù" e nient'altro — cancellando la strada
// per tornare indietro. Il numero grande invece dice cosa stai guardando ORA: con un filtro attivo
// diventa "2 di 17", così un filtro dimenticato non si traveste da flotta vuota.
export default function StatusSummary({ services = [], all = null, statusFilter = [], onStatusFilter, t = (k) => k }) {
  const fleet = all ?? services
  const counts = countByStatus(fleet)
  const total = fleet.length
  const shown = services.length
  const filtrato = shown !== total
  const attivo = (k) => statusFilter.includes(k)
  // Ripremere lo stato attivo lo toglie; con più stati selezionati dalla barra, il clic li sostituisce
  // con quello premuto (è il gesto che ci si aspetta: "mostrami questi").
  const pick = (k) => onStatusFilter?.(attivo(k) && statusFilter.length === 1 ? [] : [k])

  return (
    // data-view: ancora per il video demo, vedi pageKit.jsx.
    <div data-view="summary" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 14px' }}>
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 20, fontWeight: 700, lineHeight: 1 }} className="dg-num">
          {filtrato ? `${shown}/${total}` : total}
        </span>
        <Text type="secondary">{t('summary.services')}</Text>
      </span>
      {counts.map(({ status, count }) => {
        const on = attivo(status)
        const label = t(`card.status.${status}`)
        return (
          <button
            key={status}
            type="button"
            className={on ? 'dg-chip dg-chip-on' : 'dg-chip'}
            aria-pressed={on}
            title={on ? t('counts.all') : t('counts.only', { stato: label })}
            onClick={() => pick(status)}
            disabled={!onStatusFilter}
          >
            <StatusGlyph status={status} t={t} size={12} decorative />
            <span className="dg-num" style={{ fontWeight: 600, fontSize: 15 }}>
              {count}
            </span>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {label}
            </Text>
          </button>
        )
      })}
    </div>
  )
}
