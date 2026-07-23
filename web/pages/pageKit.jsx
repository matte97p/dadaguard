import { Typography } from 'antd'

const { Title, Text } = Typography

// Griglia responsiva per le card-account dei pannelli aggregati (affiancate 340–480px).
export const PANEL_GRID = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 480px))',
  gap: 20,
  alignItems: 'start',
  justifyContent: 'start',
}

// Bordo leggero attorno a ogni card-account, per separarle nella griglia.
export const PANEL_CARD = {
  border: '1px solid rgba(128,128,128,0.18)',
  borderRadius: 10,
  padding: 16,
}

// Intestazione comune di pagina: titolo + descrizione + eventuali controlli a destra.
export function PageIntro({ title, desc, extra }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        marginBottom: 16,
        flexWrap: 'wrap',
      }}
    >
      <div>
        <Title level={4} style={{ margin: 0 }}>
          {title}
        </Title>
        {desc && <Text type="secondary">{desc}</Text>}
      </div>
      {extra}
    </div>
  )
}

// Stat tile per gli hero di pagina: label muta piccola + valore grande. Colore solo per lo stato.
export function HeroStat({ label, value, color, size = 20 }) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.15 }}>
      <Text type="secondary" style={{ fontSize: 11 }}>
        {label}
      </Text>
      <span style={{ fontSize: size, fontWeight: 700, color }}>{value}</span>
    </span>
  )
}

// Banda hero: fila di HeroStat che va a capo pulita.
export function HeroRow({ children }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 32px', alignItems: 'flex-end', margin: '2px 0 18px' }}>
      {children}
    </div>
  )
}
