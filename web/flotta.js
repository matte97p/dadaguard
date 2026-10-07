// Le FRASI della pagina Flotta, fuori dal componente: come si dice a parole un problema di un Mac e
// l'azione che lo risolve, e come si legge una serie di sette giorni. Le regole (cosa e' un problema,
// quanto e' grave, quale azione) le decide il server in `server/flotta.js`; qui c'e' solo la lingua.
//
// Stanno qui e non dentro `FlottaPage.jsx` per poterle provare: una frase sbagliata sotto un titolo
// rosso costa la fiducia nella card, e le prove sono in `test/flotta.test.js`.
//
// Tutto puro: nessun React, nessuna fetch.

// Un numero con la virgola giusta per la lingua, a un decimale. `null` resta `null`.
const num = (x, lang) => (x == null || !Number.isFinite(Number(x)) ? null : String(Math.round(Number(x) * 10) / 10).replace('.', lang === 'it' ? ',' : '.'))
const elenco = (xs = []) => xs.filter(Boolean).join(', ')

// I tipi di problema che la pagina sa dire: deve essere lo stesso elenco di `LIVELLO` in
// server/flotta.js, e lo controlla una prova.
export const TIPI_PROBLEMA = [
  'oom',
  'dev-fermo',
  'container',
  'vm-sotto-obiettivo',
  'immagine-indietro',
  'doctor-ko',
  'lavoro-sul-mac',
  'salute-muta',
  'tool-mancanti',
  'app-pesante',
  'avvio-storto',
  'guasto',
  'motore-non-supportato',
  'opt-out-attivi',
]
export const TIPI_AZIONE = [
  'memoriaVm',
  'riavviaApp',
  'liberaMemoria',
  'aggiorna',
  'doctor',
  'dentroContainer',
  'riavviaSalute',
  'riavviaContainer',
  'cambiaMotore',
  'togliOptOut',
  'guarda',
]

export function fraseProblema(p, t = (k) => k, lang = 'it') {
  if (!p) return ''
  const k = `flotta.p.${p.tipo}`
  switch (p.tipo) {
    case 'oom': {
      const base = t(k, { n: p.quante ?? 0 })
      return p.uccisi?.length ? `${base}: ${t('flotta.p.oomUccisi', { nomi: elenco(p.uccisi) })}` : base
    }
    case 'dev-fermo':
      return [t(k), p.classe, p.dettaglio].filter(Boolean).join(': ')
    case 'container':
      return t(k, { n: p.nomi?.length ?? 0, giri: p.giri ?? 2, nomi: elenco(p.nomi) })
    case 'vm-sotto-obiettivo':
      return t(p.stimata ? 'flotta.p.vm-sotto-obiettivo.stimata' : k, { gb: num(p.vmGb, lang), obiettivo: num(p.obiettivoGb, lang) })
    case 'immagine-indietro':
      return p.giorni != null && p.giorni > 0 ? t(k, { n: p.giorni }) : t('flotta.p.immagine-indietro.versione')
    case 'doctor-ko':
      return p.falliti?.length ? `${t(k, { n: p.quante ?? 0 })}: ${elenco(p.falliti)}` : t(k, { n: p.quante ?? 0 })
    case 'lavoro-sul-mac':
      return t(k, { n: p.quante ?? 0 })
    case 'salute-muta':
      return t(k, { n: p.oreZitta ?? 24 })
    case 'tool-mancanti':
      return p.nomi?.length ? `${t(k, { n: p.quante ?? p.nomi.length })}: ${elenco(p.nomi)}` : t(k, { n: p.quante ?? 0 })
    case 'app-pesante':
      return t(k, { app: p.app, gb: num(p.gb, lang), soglia: num(p.sogliaGb, lang) })
    case 'avvio-storto':
      return t(k, { esito: p.esito ?? '?' })
    case 'guasto':
      return [t(k, { classe: p.classe ?? '?' }), p.dettaglio].filter(Boolean).join(': ')
    case 'motore-non-supportato':
      return t(k, { motore: p.motore ?? t('flotta.motoreIncerto') })
    case 'opt-out-attivi':
      return t(k, { nomi: elenco(p.nomi) })
    default:
      return p.tipo
  }
}

export function fraseAzione(a, t = (k) => k, lang = 'it') {
  if (!a) return ''
  const k = `flotta.a.${a.k}`
  switch (a.k) {
    case 'memoriaVm':
      if (a.gb == null) return t('flotta.a.memoriaVm.senzaObiettivo')
      return t(a.motore === 'docker-desktop' ? 'flotta.a.memoriaVm.desktop' : k, { gb: a.gb })
    case 'riavviaApp':
      return t(k, { app: a.app, gb: num(a.gb, lang) })
    case 'cambiaMotore':
      return t(k, { ammessi: elenco(a.ammessi) })
    case 'togliOptOut':
      return t(k, { nomi: elenco(a.nomi) })
    default:
      return t(TIPI_AZIONE.includes(a.k) ? k : 'flotta.a.guarda')
  }
}

// Una serie di sette giorni in tre numeri: l'ultimo valore, il minimo e il massimo, e per gli OOM il
// totale. I punti `null` sono ore senza righe (Mac spento): non sono zeri, e non entrano nei conti.
export function valoreSerie(serie = [], peggio = 'max') {
  const v = (serie ?? []).filter((x) => x != null && Number.isFinite(Number(x))).map(Number)
  if (!v.length) return { punti: 0, ultimo: null, min: null, max: null, totale: 0 }
  return {
    punti: v.length,
    ultimo: v[v.length - 1],
    min: Math.min(...v),
    max: Math.max(...v),
    totale: peggio === 'somma' ? v.reduce((a, b) => a + b, 0) : null,
  }
}

// La storia delle IMMAGINI dagli avvii (dal piu' recente): una voce per immagine diversa, con la data
// di costruzione e da quando e' in uso su questa macchina. Il container dichiara spesso la stessa
// immagine senza la data, quindi due avvii consecutivi con la stessa immagine sono una voce sola.
export function storiaImmagini(avvii = []) {
  const fuori = []
  for (const a of [...avvii].sort((x, y) => (y.quando ?? 0) - (x.quando ?? 0))) {
    if (!a?.immagine) continue
    const ultima = fuori[fuori.length - 1]
    if (ultima && ultima.immagine === a.immagine) {
      ultima.dal = Math.min(ultima.dal, a.quando ?? ultima.dal)
      ultima.creata = ultima.creata ?? a.creata ?? null
      continue
    }
    fuori.push({ immagine: a.immagine, creata: a.creata ?? null, dal: a.quando ?? 0 })
  }
  return fuori
}
