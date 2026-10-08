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
  'aspettaTest',
  'senzaReload',
  'spegniCopie',
  'guarda',
]

// Le parole di UNA causa dell'app pesante (`diagnosiApp` in shared/devEnv.js): «pesa uvicorn: il
// server stesso cresce», «test in corso», «il reload», «2 copie accese».
export function fraseCausa(c, t = (k) => k, lang = 'it') {
  switch (c?.k) {
    case 'categoria':
      return t('flotta.causa.categoria', { cat: c.cat, spiega: t(`flotta.cat.spiega.${c.cat}`) })
    case 'test':
      return t('flotta.causa.test', { gb: num(c.gb, lang), n: c.n ?? 0 })
    case 'reload':
      return t('flotta.causa.reload', { gb: num(c.gb, lang) })
    case 'copie':
      return t('flotta.causa.copie', { n: c.n ?? 0 })
    default:
      return ''
  }
}

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
    case 'app-pesante': {
      const base = t(k, { app: p.app, gb: num(p.gb, lang), soglia: num(p.sogliaGb, lang) })
      const cause = (p.cause ?? []).map((c) => fraseCausa(c, t, lang)).filter(Boolean)
      if (!cause.length) return base
      const testo = cause.join('; ')
      return `${base}. ${testo.charAt(0).toUpperCase()}${testo.slice(1)}`
    }
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
    case 'aspettaTest':
      return t(k, { app: a.app })
    case 'senzaReload':
      return t(k, { app: a.app, gb: num(a.gb, lang) })
    case 'spegniCopie':
      return a.quali?.length ? t('flotta.a.spegniCopie.quali', { n: a.n ?? a.quali.length, quali: elenco(a.quali) }) : t(k, { n: a.n ?? 0 })
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
  // L'app piu' pesante dentro al container. Sopra la soglia, e quando il Mac manda le categorie, la
  // cella dice anche QUALE processo la tiene («backend 9,9 GB · uvicorn 9,2»); il titolo le elenca.
  {
    const a = (m?.app ?? [])[0]
    const pesante = (m?.problemi ?? []).find((p) => p.tipo === 'app-pesante')
    const nome = pesante?.app ?? a?.nome
    const gb = pesante?.gb ?? a?.gb
    const voce = (m?.app ?? []).find((x) => x.nome === nome)
    const top = pesante && voce?.categorie?.length ? [...voce.categorie].sort((x, y) => y.mb - x.mb)[0] : null
    const valore = nome ? `${nome} ${num(gb, lang)} GB${top ? ` · ${top.cat} ${num(top.mb / 1024, lang)}` : ''}` : null
    const c = cella('app', { livello: nome ? 'ok' : null, valore })
    const cat = voce?.categorie?.length ? elencoCategorie(voce, t, lang) : null
    if (cat) c.titolo = [cat, c.problemi ? c.titolo : null].filter(Boolean).join('\n')
    fuori.push(c)
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

// ── Cosa gira dentro alle app (dal 08/10/2026) ─────────────────────────────────────────────────────
//
// Il COLORE di ogni categoria di processi, uguale ovunque (la barra del dettaglio, la legenda). La
// palette dei grafici ha quattro colori e le categorie sono nove: un colore generato in piu' sarebbe
// indistinguibile dagli altri, quindi le categorie si raggruppano per quello che dicono di una app
// che cresce, e il resto va nel grigio di contesto:
//   · il server (uvicorn per Python, node per vite e next: un servizio ne ha uno solo dei due);
//   · il reload, i worker e i test, che sono le tre cause che la diagnosi nomina;
//   · build, python, avvio e altro in grigio: ci sono, ma non sono la notizia.
// Ogni pezzo della barra porta comunque il nome della sua categoria nel titolo.
export const GRUPPI_CATEGORIE = Object.freeze([
  { k: 'server', cat: ['uvicorn', 'node'], colore: 'var(--chart-1)' },
  { k: 'reload', cat: ['reload'], colore: 'var(--chart-2)' },
  { k: 'test', cat: ['test'], colore: 'var(--chart-3)' },
  { k: 'worker', cat: ['worker'], colore: 'var(--chart-4)' },
  { k: 'resto', cat: ['build', 'python', 'avvio', 'altro'], colore: 'var(--chart-neutro)' },
])
export const COLORE_CATEGORIA = Object.freeze(Object.fromEntries(GRUPPI_CATEGORIE.flatMap((g) => g.cat.map((c) => [c, g.colore]))))
export const coloreCategoria = (cat) => COLORE_CATEGORIA[cat] ?? 'var(--chart-neutro)'

// «uvicorn 9,2 GB · reload 0,4 GB · test 0,1 GB (2)»: le categorie di un'app dalla piu' pesante, per
// il titolo della cella e della barra. Il numero di processi solo quando e' piu' di uno.
export function elencoCategorie(a, t = (k) => k, lang = 'it') {
  return [...(a?.categorie ?? [])]
    .sort((x, y) => y.mb - x.mb)
    .map((c) => `${c.cat} ${pesoMb(c.mb, lang)}${c.n > 1 ? ` (${c.n})` : ''}`)
    .join(' · ')
}

// Un peso in MB detto come si legge: sotto i 100 MB in MB («40 MB», non «0 GB»), sopra in GB.
export const pesoMb = (mb, lang = 'it') => (mb == null ? '-' : mb < 100 ? `${Math.round(mb)} MB` : `${num(mb / 1024, lang)} GB`)

// Le righe della sezione «Cosa gira»: per ogni app il totale, i processi e i pezzi della barra, larghi
// in proporzione a `scalaMb` (la memoria della VM, come la sezione dei container sopra; senza, l'app
// piu' pesante). Un'app senza categorie (`app_mb` soltanto) ha un pezzo solo, grigio, e i processi a
// `null`: il totale si sa, la composizione no.
export function righeProcessi(app = [], scalaMb = null) {
  const voci = (app ?? []).filter((a) => a && (a.mb ?? a.gb * 1024) > 0)
  if (!voci.length) return []
  const mbDi = (a) => a.mb ?? Math.round(a.gb * 1024)
  const scala = Math.max(scalaMb ?? 0, ...voci.map(mbDi))
  return voci.map((a) => {
    const tot = mbDi(a)
    const conCat = a.categorie?.length > 0
    const pezzi = conCat
      ? a.categorie.filter((c) => c.mb > 0).map((c) => ({ cat: c.cat, n: c.n, mb: c.mb, colore: coloreCategoria(c.cat), pct: (c.mb / scala) * 100 }))
      : [{ cat: null, n: null, mb: tot, colore: 'var(--chart-neutro)', pct: (tot / scala) * 100 }]
    return { nome: a.nome, mb: tot, gb: a.gb, processi: a.processi ?? null, conCategorie: conCat, pezzi }
  })
}

// La legenda della sezione, una volta sola: i gruppi che compaiono in almeno una barra, con le
// categorie vere fra parentesi quando il gruppo ne ha piu' d'una.
export function legendaProcessi(righe = [], t = (k) => k) {
  const viste = new Set(righe.flatMap((r) => r.pezzi.map((p) => p.cat).filter(Boolean)))
  return GRUPPI_CATEGORIE.filter((g) => g.cat.some((c) => viste.has(c))).map((g) => {
    const dentro = g.cat.filter((c) => viste.has(c))
    const nome = t(`flotta.gruppo.${g.k}`)
    return { k: g.k, colore: g.colore, etichetta: g.cat.length > 1 ? `${nome} (${dentro.join(', ')})` : nome }
  })
}

// La riga del lanciatore delle app: servizi accesi, copie e il reload delle copie. «non lo so» resta
// fuori: senza il blocco la riga non c'e', e un reload `null` non si dice.
export function rigaCopie(c, t = (k) => k) {
  if (!c) return null
  const pezzi = []
  if (c.servizi) pezzi.push(c.servizi.length ? t('flotta.run.servizi', { nomi: elenco(c.servizi) }) : t('flotta.run.nessunServizio'))
  if (c.copie != null) {
    if (c.copie === 0) pezzi.push(t('flotta.run.nessunaCopia'))
    else {
      const quali = Object.entries(c.copieServizi ?? {})
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([n, xs]) => t('flotta.run.copia', { n, nomi: xs.length ? elenco(xs) : '-' }))
      pezzi.push(quali.length ? `${t('flotta.run.copie', { n: c.copie })} (${quali.join('; ')})` : t('flotta.run.copie', { n: c.copie }))
      if (c.reload != null) pezzi.push(t(c.reload ? 'flotta.run.reloadSi' : 'flotta.run.reloadNo'))
    }
  }
  return pezzi.length ? pezzi.join(' · ') : null
}
