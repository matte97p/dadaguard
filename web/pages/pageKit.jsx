import { Typography, Empty, Space } from 'antd'
import { SPACE, FONT } from '../theme.js'

const { Title, Text } = Typography

// I pezzi che compongono OGNI pagina. Esistono perché la stessa cosa era disegnata a mano in nove
// posti: un titolino in grassetto qui, un bordo con raggio 10 là, `marginBottom: 16` in una pagina e
// `12` in quella accanto. Nessuno di quei valori era sbagliato da solo; insieme facevano sembrare
// l'app un collage. Da qui in poi la decisione si prende UNA volta.

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
  gap: SPACE.lg,
  alignItems: 'start',
}

// Bordo leggero attorno a ogni card-account, per separarle nella griglia.
export const PANEL_CARD = {
  border: '1px solid var(--dg-line)',
  borderRadius: 12,
  padding: SPACE.lg,
}

// Intestazione comune di pagina: titolo + descrizione + eventuali controlli a destra.
export function PageIntro({ title, desc, extra }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: SPACE.lg,
        marginBottom: SPACE.lg,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0 }}>
        {/* Titolo assente = pagina dentro una scheda: il nome ce l'ha già la scheda, e ripeterlo due
            righe sotto occupa la parte alta senza aggiungere niente. La descrizione resta: quella
            dice cosa stai guardando, e la scheda non la sa dire. */}
        {title && (
          <Title level={4} className="dg-page-title" style={{ margin: 0, fontSize: FONT.title, fontWeight: 600 }}>
            {title}
          </Title>
        )}
        {desc && (
          <Text className="dg-page-desc" style={{ fontSize: FONT.small, display: 'block', marginTop: title ? 2 : 0 }}>
            {desc}
          </Text>
        )}
      </div>
      {extra}
    </div>
  )
}

// Fila di controlli (filtri, interruttori, ricerca). Sta a destra del titolo o sopra una tabella, e
// ha un allineamento solo: senza, ogni pagina inventa il suo e i controlli ballano di venti pixel
// passando da una all'altra.
export function Toolbar({ children, align = 'end' }) {
  return (
    <Space size={SPACE.md} wrap style={{ justifyContent: align === 'end' ? 'flex-end' : 'flex-start', rowGap: SPACE.sm }}>
      {children}
    </Space>
  )
}

// Blocco di contenuto con etichetta. `tone='live'` colora il bordo sinistro: serve alle sezioni che
// portano un segnale (qualcosa sta girando ADESSO), dove il colore indica invece di urlare.
export function Section({ title, aside, tone, children, style }) {
  return (
    <section className={`dg-section${tone === 'live' ? ' dg-section-live' : ''}`} style={style}>
      {(title || aside) && (
        <header className="dg-section-head">
          {title && <span className="dg-section-title">{title}</span>}
          {aside}
        </header>
      )}
      {children}
    </section>
  )
}

// Stat tile per gli hero di pagina: label muta piccola + valore grande. Colore solo per lo stato.
export function HeroStat({ label, value, color, size = FONT.stat, hint }) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.15 }}>
      <Text type="secondary" style={{ fontSize: FONT.micro, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </Text>
      <span className="dg-stat-value" style={{ fontSize: size, fontWeight: 650, color, letterSpacing: '-0.02em' }}>
        {value}
      </span>
      {hint && (
        <Text type="secondary" style={{ fontSize: FONT.micro }}>
          {hint}
        </Text>
      )}
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
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: `${SPACE.md}px ${SPACE.xxl}px`,
        alignItems: 'flex-end',
        margin: `2px 0 ${SPACE.lg}px`,
      }}
    >
      {children}
    </div>
  )
}

// Stato vuoto con una FRASE, non con «Nessun dato». Un vuoto senza spiegazione manda a cercare un
// guasto dove non c'è: quasi sempre il vuoto è una risposta (nessun problema, nessuna corsa in questa
// finestra) e va detta come tale.
export function EmptyState({ description, extra }) {
  return (
    <div style={{ padding: `${SPACE.xxl}px 0` }}>
      <Empty description={description} image={Empty.PRESENTED_IMAGE_SIMPLE}>
        {extra}
      </Empty>
    </div>
  )
}
