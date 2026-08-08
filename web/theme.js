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
export const SURFACE = {
  border: '1px solid rgba(128,128,128,0.18)',
  rowBg: 'rgba(128,128,128,0.05)',
  trackBg: 'rgba(128,128,128,0.18)',
}

export const MONO = 'ui-monospace, SFMono-Regular, monospace'

// Configurazione tema antd. `algorithm` arriva da fuori (l'oggetto `theme` di antd) per non
// importare antd in un modulo di soli token — così questo file resta caricabile anche dai test.
export function antdTheme(algorithm) {
  return {
    algorithm,
    token: { colorPrimary: BRAND, borderRadius: 8 },
  }
}
