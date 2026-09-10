import { Typography, Empty, Space, Segmented } from 'antd'
import { SPACE, FONT, levelColor } from '../theme.js'

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

// IL VERDETTO: la prima cosa che si legge aprendo una pagina, e la risposta alla domanda che quella
// pagina esiste per rispondere. Una riga, un numero, un colore.
//
// Perché esiste. Il 10/09/2026 le quattordici pagine si aprivano con **39 banner `Alert`** in totale
// (dieci nella sola Accessi) e ZERO blocchi di sintesi: ognuno diceva una fetta della stessa cosa,
// e la risposta andava ricomposta leggendoli tutti, più la riga di nota, più una colonna della
// tabella. Chi apre una pagina durante un guasto non ricompone niente: guarda la prima riga.
//
// La regola che ne segue, e vale su TUTTE le pagine: sotto il titolo c'è un verdetto, e sotto il
// verdetto il dettaglio. L'`Alert` resta per l'eccezione vera (i dati non si sono caricati), al
// massimo uno per pagina: tutto il resto è una riga di questo blocco o una colonna della tabella.
//
// `livello` colora SOLO il bordo sinistro e il valore, mai lo sfondo: un blocco pieno di colore in
// cima a ogni pagina è un allarme che suona sempre, e un allarme che suona sempre non si sente più.
export function Verdetto({ livello = 'ok', titolo, dettaglio, numeri, extra }) {
  const colore = levelColor(livello)
  return (
    <div
      data-view="verdetto"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: SPACE.lg,
        flexWrap: 'wrap',
        borderInlineStart: `3px solid ${colore}`,
        paddingInlineStart: SPACE.lg,
        margin: `0 0 ${SPACE.lg}px`,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: FONT.lead, fontWeight: 600, color: colore, letterSpacing: '-0.01em' }}>{titolo}</div>
        {/* Il dettaglio è una frase, non un secondo titolo: dice COSA fare o chi è messo male, e sta
            in grigio perché la decisione l'ha già data la riga sopra. */}
        {dettaglio && (
          <Text type="secondary" style={{ fontSize: FONT.small, display: 'block', marginTop: 2 }}>
            {dettaglio}
          </Text>
        )}
      </div>
      {/* I numeri che contano, al massimo tre: oltre non si leggono in un colpo d'occhio, e il quarto
          numero è sempre quello che spinge il verdetto sotto la piega. */}
      {numeri?.length ? <HeroRow>{numeri.slice(0, 3).map((n) => <HeroStat key={n.label} {...n} />)}</HeroRow> : null}
      {extra}
    </div>
  )
}

// IL CONTROLLO DI FINESTRA, uguale su tutte le pagine che ne hanno una.
//
// I gradini NON stanno qui: li dichiara `server/finestre.conf` e li serve `/api/finestre`, perche' un
// elenco ricopiato in quattordici pagine diventa quattordici elenchi diversi al primo che ne cambia
// uno. Qui c'e' solo la forma: etichette corte, il valore corrente evidente, e nient'altro.
//
// ⚠️ Il default e' STRETTO apposta (un'ora sugli accessi): queste pagine si aprono durante un guasto,
// e aspettare mezzo minuto per vedere una settimana di eventi quando la domanda era «cosa succede
// adesso» era il motivo per cui erano lente. Chi vuole guardare indietro lo chiede.
export function FinestraSwitch({ ore, gradini, onChange, t }) {
  if (!gradini?.length || gradini.length < 2) return null
  const etichetta = (h) => (h < 24 ? `${h}h` : h % 24 === 0 && h < 168 ? `${h / 24}g` : h === 168 ? '7g' : `${Math.round(h / 24)}g`)
  return (
    <Space size={SPACE.sm}>
      <Text type="secondary" style={{ fontSize: FONT.small }}>
        {t ? t('finestra.label') : 'Finestra'}
      </Text>
      <Segmented
        size="small"
        value={ore}
        onChange={onChange}
        options={gradini.map((h) => ({ label: etichetta(h), value: h }))}
      />
    </Space>
  )
}

// Il dato e' stato TAGLIATO dal tetto: si dice, sempre. Un dato parziale letto come completo e'
// peggio di un dato che manca, e il tetto senza questa riga e' esattamente quello.
export function Troncato({ children }) {
  if (!children) return null
  return (
    <Text type="warning" style={{ fontSize: FONT.small, display: 'block', marginBottom: SPACE.sm }}>
      {children}
    </Text>
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
