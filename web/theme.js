// Token di tema — un posto solo per i colori che vogliono dire qualcosa.
//
// Prima gli stessi sei valori esadecimali erano ripetuti in una dozzina di file (`#52c41a` per "ok",
// `#ff4d4f` per "giù", `#faad14` per "attenzione"…). Il problema non è la ripetizione: è che due
// pagine possono divergere senza che nessuno se ne accorga, e allora lo stesso stato si legge di due
// colori diversi in due punti — cioè il colore smette di essere un segnale.
//
// La palette è quella di antd, non una nostra: così i componenti antd (Tag, Badge, Alert) e i pezzi
// disegnati a mano restano coerenti senza doverli accordare a occhio.

// Livelli di SEGNALE, in ordine di gravità. Sono quattro perché quattro sono le decisioni diverse:
// intervenire adesso · guardare oggi · sapere che è successo · niente da fare.
export const LEVEL = {
  crit: { color: '#cf1322', tag: 'error', badge: 'error' },
  bad: { color: '#ff4d4f', tag: 'error', badge: 'error' },
  warn: { color: '#faad14', tag: 'warning', badge: 'warning' },
  info: { color: '#1677ff', tag: 'processing', badge: 'processing' },
  ok: { color: '#52c41a', tag: 'success', badge: 'success' },
  muted: { color: '#8c8c8c', tag: 'default', badge: 'default' },
}

export const levelColor = (level) => (LEVEL[level] ?? LEVEL.muted).color

// Viola Dadaguard: colore del marchio, usato per il primario e per gli affordance di navigazione.
// Non è un livello di segnale e non deve mai indicarne uno.
export const BRAND = '#7c3aed'

// Colori "di dominio", quelli che identificano un provider e non uno stato.
export const PROVIDER = { cloudflare: '#f6821f', aws: '#ff9900' }

// Superfici e bordi: le due tinte neutre che tornano in ogni pannello. In rgba invece di un grigio
// pieno perché devono funzionare in chiaro e in scuro senza due valori da tenere allineati.
// I valori sono le VARIABILI CSS dello strato base (web/app.css), non tre rgba scritti qui: il tema si
// cambia in JS, quindi un grigio fisso al 18% va bene in chiaro e sparisce in scuro (o viceversa). Con
// la variabile, la stessa riga di codice segue il tema, e chi importa SURFACE non deve saperlo.
export const SURFACE = {
  border: '1px solid var(--dg-line)',
  borderStrong: '1px solid var(--dg-line-strong)',
  rowBg: 'var(--dg-row)',
  trackBg: 'var(--dg-track)',
  brandSoft: 'var(--dg-brand-soft)',
}

export const MONO = 'ui-monospace, SFMono-Regular, monospace'

// SCALA DI SPAZIATURE. Non è pedanteria: prima ogni pagina scriveva i suoi `marginBottom: 16`,
// `gap: 12`, `padding: '9px 12px'` a mano, e il risultato è che due blocchi affiancati respirano in
// modo diverso: l'occhio lo legge come "fatto da due persone", che è esattamente l'impressione da
// togliere. Quattro passi bastano a tutta l'app: dentro un elemento, fra elementi, fra blocchi, fra
// sezioni.
export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 }

// SCALA TIPOGRAFICA, in punti che si distinguono a occhio. Sotto i 11px il testo non si legge e non
// vale la pena averlo; sopra i 20 in una dashboard non serve niente.
export const FONT = { micro: 11, small: 12, body: 13, lead: 15, title: 20, stat: 22 }

// Tinte dell'inchiostro: il TESTO ha tre livelli di importanza e non uno. Un'etichetta grigia accanto
// a un valore nero è il modo più economico di dire "questo conta, quest'altro spiega".
export const INK = { strong: 1, mute: 0.65, faint: 0.45 }

// Configurazione tema antd. `algorithm` arriva da fuori (l'oggetto `theme` di antd) per non
// importare antd in un modulo di soli token — così questo file resta caricabile anche dai test.
//
// Perché tanti token e non un CSS per pagina: i componenti antd sono il 90% di ciò che si vede
// (tabelle, card, tag, menu, drawer). Accordarli QUI significa che ogni pagina, anche quelle che non
// tocco, cambia insieme; accordarli nelle pagine significa che la decima pagina non somiglia alla
// prima. `dark` serve perché le neutre non si possono derivare: in scuro un bordo al 6% sparisce.
export function antdTheme(algorithm, dark = false) {
  const linea = dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.09)'
  const tenue = dark ? 'rgba(255,255,255,0.045)' : 'rgba(15,23,42,0.028)'
  const brandTenue = dark ? 'rgba(124,58,237,0.22)' : 'rgba(124,58,237,0.07)'
  return {
    algorithm,
    token: {
      colorPrimary: BRAND,
      colorInfo: BRAND,
      // 13px di base, non 14: questa è una dashboard densa, e un punto in meno è una riga in più di
      // tabella visibile senza scorrere. La gerarchia la fanno i pesi e le tinte, non il corpo.
      fontSize: FONT.body,
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      fontFamilyCode: MONO,
      borderRadius: 8,
      borderRadiusLG: 12,
      borderRadiusSM: 6,
      controlHeight: 30,
      lineHeight: 1.5,
      colorBorderSecondary: linea,
      colorBgLayout: dark ? '#141416' : '#f7f7fa',
      colorBgContainer: dark ? '#1b1b1f' : '#ffffff',
      colorBgElevated: dark ? '#212127' : '#ffffff',
      // Ombre appena percepibili: una dashboard piena di ombre marcate sembra un collage di finestre.
      boxShadow: dark ? '0 1px 2px rgba(0,0,0,0.5)' : '0 1px 2px rgba(15,23,42,0.05)',
      boxShadowSecondary: dark ? '0 6px 20px rgba(0,0,0,0.5)' : '0 6px 20px rgba(15,23,42,0.09)',
      wireframe: false,
    },
    components: {
      // TABELLE: sono la forma principale in cui questa app dice le cose. Intestazione muta e
      // trasparente (etichetta, non barra), celle compatte, riga sotto il puntatore in viola basso —
      // lo stesso viola della navigazione, così "dove sono" e "cosa sto guardando" parlano uguale.
      Table: {
        headerBg: 'transparent',
        headerColor: dark ? 'rgba(255,255,255,0.55)' : 'rgba(15,23,42,0.55)',
        headerSplitColor: 'transparent',
        borderColor: linea,
        rowHoverBg: brandTenue,
        cellPaddingBlock: 9,
        cellPaddingInline: 12,
        cellPaddingBlockSM: 7,
        cellPaddingInlineSM: 10,
        footerBg: 'transparent',
      },
      Card: { paddingLG: SPACE.lg, headerFontSize: FONT.lead, headerHeight: 42, headerHeightSM: 36 },
      // MENU: voci con angoli tondi e selezione piena viola basso. La selezione di serie è una barra
      // laterale sottile che a colpo d'occhio non si vede, e una navigazione dove non sai dove sei è
      // il primo motivo per cui una dashboard sembra difficile.
      Menu: {
        itemBorderRadius: 8,
        itemMarginInline: SPACE.sm,
        itemHeight: 34,
        itemSelectedBg: brandTenue,
        itemSelectedColor: dark ? '#c4a5ff' : BRAND,
        itemHoverBg: tenue,
        groupTitleColor: dark ? 'rgba(255,255,255,0.4)' : 'rgba(15,23,42,0.4)',
        groupTitleFontSize: FONT.micro,
        iconMarginInlineEnd: SPACE.md,
        activeBarWidth: 0,
      },
      Segmented: { itemSelectedBg: dark ? '#2b2b33' : '#ffffff', trackBg: tenue, borderRadius: 8 },
      Tag: { defaultBg: tenue, borderRadiusSM: 6 },
      Button: { fontWeight: 500, primaryShadow: 'none', defaultShadow: 'none' },
      Alert: { borderRadiusLG: 10, withDescriptionPadding: `${SPACE.md}px ${SPACE.lg}px` },
      Drawer: { paddingLG: SPACE.xl, footerPaddingBlock: SPACE.md },
      Tooltip: { borderRadius: 8, fontSize: FONT.small },
      Empty: { colorTextDescription: dark ? 'rgba(255,255,255,0.45)' : 'rgba(15,23,42,0.45)' },
      Statistic: { contentFontSize: FONT.stat },
      Skeleton: { borderRadiusSM: 6 },
      Input: { paddingBlock: 3 },
      Switch: { handleSize: 14, trackHeight: 18, trackMinWidth: 34 },
      Badge: { dotSize: 7 },
      Progress: { defaultColor: BRAND },
    },
  }
}
