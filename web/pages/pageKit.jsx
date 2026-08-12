import { Typography } from 'antd'

const { Title, Text } = Typography

// Griglia responsiva per le card-account dei pannelli aggregati.
//
// Il minimo è 300px e non 340: su un portatile (finestra ~1200px, meno la sidebar) 340 ne faceva
// stare DUE, e la terza andava a capo lasciando mezza riga vuota — con tre account, la vista
// diventava alta il doppio per niente. A 300 i tre stanno in fila su quella larghezza, e le colonne
// si allargano fino a 480 quando lo schermo lo permette: la card non diventa mai un lenzuolo, che è
// il difetto opposto.
// `1fr` come massimo, non `480px`: con un massimo FISSO il numero di colonne si calcola su quello —
// 480 per colonna significa che sotto i ~1500px di contenuto ne sta UNA, e su un portatile si vedeva
// una card per riga con mezzo schermo vuoto a destra. Con `1fr` il conto si fa sul minimo (300px), le
// colonne diventano tre e poi si allargano a riempire la riga.
export const PANEL_GRID = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
  gap: 16,
  alignItems: 'start',
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
        {/* Titolo assente = pagina dentro una scheda: il nome ce l'ha già la scheda, e ripeterlo due
            righe sotto occupa la parte alta senza aggiungere niente. La descrizione resta: quella
            dice cosa stai guardando, e la scheda non la sa dire. */}
        {title && (
          <Title level={4} style={{ margin: 0 }}>
            {title}
          </Title>
        )}
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
//
// `data-view`: ancora per il video demo (`demowright.story.js`). Zoom e highlight risolvono il
// selettore con `document.querySelector` DENTRO la pagina, quindi possono agganciarsi solo a CSS —
// non al testo, che è tradotto, né alla posizione, che cambia al primo riordino. Senza un'ancora
// stabile il video si registra su `nth-child` e si rompe in silenzio: continua a girare, inquadrando
// il riquadro sbagliato. Stessa ragione del `data-service` sulle righe della tabella.
export function HeroRow({ children }) {
  return (
    <div
      data-view="hero"
      style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 32px', alignItems: 'flex-end', margin: '2px 0 18px' }}
    >
      {children}
    </div>
  )
}
