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

// ── La MATRICE della flotta (dal 07/10/2026) ───────────────────────────────────────────────────────
//
// Una riga per Mac, una colonna per cosa si guarda. Ogni cella e' un valore corto e un livello:
//   · `ok`: in ordine, si scrive in grigio (il valore c'e', ma non chiama);
//   · `warn`, `crit`, `info`: c'e' un problema, col pallino del colore e il valore;
//   · `null`: non lo so (il Mac non manda quel campo), e si disegna come un trattino tenue.
// Le colonne pescano dai PROBLEMI che il server ha gia' deciso (`server/flotta.js`): qui non si rifa'
// nessuna regola, si sceglie solo dove mostrarla. `titolo` e' la frase intera, per il mouse e per chi
// legge con uno screen reader.
export const COLONNE = ['immagine', 'vm', 'oom', 'motore', 'salute', 'doctor', 'avvio', 'sulMac', 'app']

// Quale colonna mostra quale problema. Ogni tipo del server ha la sua: un problema senza colonna
// sarebbe un pallino rosso nella riga senza una cella che dica perche' (c'e' una prova).
export const COLONNA_DEL_PROBLEMA = {
  'immagine-indietro': 'immagine',
  'tool-mancanti': 'immagine',
  'vm-sotto-obiettivo': 'vm',
  oom: 'oom',
  'motore-non-supportato': 'motore',
  'salute-muta': 'salute',
  'doctor-ko': 'doctor',
  'dev-fermo': 'avvio',
  'avvio-storto': 'avvio',
  guasto: 'avvio',
  container: 'avvio',
  'lavoro-sul-mac': 'sulMac',
  'opt-out-attivi': 'sulMac',
  'app-pesante': 'app',
}

const RANGO_LIV = { crit: 0, warn: 1, info: 2, ok: 3 }

export function celleMac(m, t = (k) => k, lang = 'it', adesso = Date.now()) {
  const breve = (ts) => {
    if (!Number.isFinite(ts)) return null
    const min = Math.max(0, Math.round((adesso - ts) / 60_000))
    if (min < 1) return t('ago.now')
    if (min < 60) return `${min}${t('time.unit.m')}`
    const h = Math.floor(min / 60)
    return h < 48 ? `${h}${t('time.unit.h')}` : `${Math.floor(h / 24)}${t('time.unit.d')}`
  }
  const problemi = (col) =>
    (m?.problemi ?? []).filter((p) => COLONNA_DEL_PROBLEMA[p.tipo] === col).sort((a, b) => RANGO_LIV[a.livello] - RANGO_LIV[b.livello])
  const cella = (k, base) => {
    const ps = problemi(k)
    if (!ps.length) return { k, ...base }
    return { k, ...base, livello: ps[0].livello, titolo: ps.map((p) => fraseProblema(p, t, lang)).join(' · '), problemi: ps.map((p) => p.tipo) }
  }
  const uso = m?.uso ?? {}
  const vm = m?.vm ?? {}
  const impostata = vm.impostataGb ?? vm.gb
  const fuori = []

  // Immagine: quanti giorni dietro la piu' nuova; «attuale» quando e' dello stesso giorno.
  {
    const ind = (m?.problemi ?? []).find((p) => p.tipo === 'immagine-indietro')
    const tool = (m?.problemi ?? []).find((p) => p.tipo === 'tool-mancanti')
    const g = ind?.giorni ?? m?.immagine?.giorni
    const nota = m?.immagine?.creata || ind
    let valore = null
    if (ind) valore = g > 0 ? t('flotta.c.giorni', { n: g }) : t('flotta.c.diversa')
    else if (tool) valore = t('flotta.c.tool', { n: tool.quante ?? tool.nomi?.length ?? 0 })
    else if (nota) valore = g > 0 ? t('flotta.c.giorni', { n: g }) : t('flotta.c.attuale')
    fuori.push(cella('immagine', { livello: valore == null ? null : 'ok', valore, titolo: m?.immagine?.creata ? t('flotta.immagineDel', { data: new Date(Date.parse(m.immagine.creata)).toLocaleDateString(lang === 'it' ? 'it-IT' : 'en-GB') }) : null }))
  }
  // VM: la memoria impostata contro l'obiettivo, con la barra.
  {
    const ob = vm.obiettivoGb
    const valore = impostata == null ? null : ob != null ? `${num(impostata, lang)}/${num(ob, lang)}` : `${num(impostata, lang)} GB`
    fuori.push(
      cella('vm', {
        livello: valore == null ? null : 'ok',
        valore,
        // La barra solo quando la VM e' sotto l'obiettivo: su sei righe in ordine sei barre piene sono
        // sei segni che non dicono niente.
        barra: impostata != null && ob && impostata < ob - 0.5 ? Math.min(100, (impostata / ob) * 100) : null,
        titolo: impostata != null && ob != null ? t('flotta.vmSuObiettivo', { gb: num(impostata, lang), obiettivo: num(ob, lang) }) : null,
      }),
    )
  }
  // OOM delle ultime 24 ore. Zero e' un fatto solo se il Mac manda il contatore.
  fuori.push(cella('oom', { livello: m?.oom ? 'ok' : null, valore: m?.oom ? String(m.oom.nuovi ?? 0) : null }))
  // Motore di Docker.
  {
    const valore = m?.motore ?? (m?.motoreIncerto ? t('flotta.motoreIncerto') : null)
    fuori.push(cella('motore', { livello: valore ? 'ok' : null, valore }))
  }
  // Salute: quanto e' fresca l'ultima riga.
  {
    const ultima = Number(m?.saluteUltima) || null
    fuori.push(cella('salute', { livello: m?.saluteAssente || !ultima ? null : 'ok', valore: m?.saluteAssente ? null : breve(ultima), titolo: ultima ? t('flotta.c.saluteTitolo', { quando: breve(ultima) }) : null }))
  }
  // Doctor: l'esito dell'ultimo.
  {
    const d = uso.doctor
    const ko = Number(d?.ko) || 0
    const valore = d ? (ko > 0 ? t('flotta.c.ko', { n: ko }) : t('flotta.c.ok')) : null
    fuori.push(cella('doctor', { livello: valore ? 'ok' : null, valore }))
  }
  // Avvio: l'esito dell'ultimo, e i guasti.
  {
    const ps = problemi('avvio')
    const ultimo = (m?.storia ?? [])[0]
    let valore = ultimo?.esito ? (ultimo.esito === 'ok' ? t('flotta.c.ok') : ultimo.esito) : null
    if (ps[0]?.tipo === 'dev-fermo') valore = t('flotta.c.fermo')
    else if (ps[0]?.tipo === 'avvio-storto') valore = ps[0].esito ?? valore
    else if (ps[0]?.tipo === 'guasto') valore = ps[0].classe ?? t('flotta.c.guasto')
    else if (ps[0]?.tipo === 'container') valore = t('flotta.c.container', { n: ps[0].nomi?.length ?? 0 })
    fuori.push(cella('avvio', { livello: valore ? 'ok' : null, valore }))
  }
  // Comandi dei repo lanciati sul Mac nelle 24 ore, e gli opt-out.
  {
    const ps = problemi('sulMac')
    // `uso` c'e' sempre (il server lo compone anche senza salute), quindi «so quanti comandi» vuol dire
    // «questo Mac ha mandato la salute nelle 24 ore», che e' quando c'e' il blocco `oom`.
    let valore = m?.oom ? String(uso.sulMac ?? 0) : null
    if (ps[0]?.tipo === 'lavoro-sul-mac') valore = String((m.problemi.find((p) => p.tipo === 'lavoro-sul-mac')?.quante ?? uso.sulMac) || 0)
    else if (ps[0]?.tipo === 'opt-out-attivi') valore = t('flotta.c.optOut', { n: ps[0].nomi?.length ?? 0 })
    fuori.push(cella('sulMac', { livello: valore != null ? 'ok' : null, valore }))
  }
  // L'app piu' pesante dentro al container.
  {
    const a = (m?.app ?? [])[0]
    const pesante = (m?.problemi ?? []).find((p) => p.tipo === 'app-pesante')
    const nome = pesante?.app ?? a?.nome
    const gb = pesante?.gb ?? a?.gb
    fuori.push(cella('app', { livello: nome ? 'ok' : null, valore: nome ? `${nome} ${num(gb, lang)} GB` : null }))
  }
  return fuori
}

// Le AZIONI della flotta in una riga, sotto la matrice: per ogni azione (la prima di ogni Mac da
// sistemare) quali Mac. «memoria della VM: kim · aggiorna: sam, eli». Le azioni nell'ordine del Mac
// piu' grave che le chiede.
export function azioniFlotta(macchine = []) {
  const perAzione = new Map()
  for (const m of macchine) {
    if (!(m.livello === 'crit' || m.livello === 'warn')) continue
    const a = m.problemi?.find((p) => p.livello === m.livello)?.azione ?? m.problemi?.[0]?.azione
    if (!a?.k) continue
    if (!perAzione.has(a.k)) perAzione.set(a.k, { k: a.k, livello: m.livello, macchine: [] })
    perAzione.get(a.k).macchine.push(m.macchina)
  }
  return [...perAzione.values()]
}
