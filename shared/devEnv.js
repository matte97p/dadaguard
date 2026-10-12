// Le REGOLE sulle macchine del dev-env che servono sia al server sia alla pagina: cos'e' una versione,
// qual e' l'immagine di riferimento, quando una macchina e' indietro, e come si legge l'uso del
// dev-env dalla riga di salute.
//
// Stavano in `web/accessi.js`, accanto alle regole della pagina Accessi. Dal 07/10/2026 il dev-env ha
// una pagina sua (Flotta) e le regole le applica il SERVER, che compone le card per macchina: una
// regola sola, letta da tutti e due i lati, invece di due copie che un giorno dicono due cose. Le
// prove sono in `test/accessi.test.js` e in `test/flotta.test.js`.
//
// Tutto puro: nessun React, nessuna fetch, nessuna data «adesso» letta da dentro.

// Una versione VERA, cioè un digest. Serve perché l'heartbeat manda anche la parola con cui dichiara
// di non sapere («sconosciuta», quando l'avvio non ha potuto leggere l'immagine), e trattarla come una
// versione ha due conseguenze, entrambe viste sui dati veri il 31/08/2026: entra nel conteggio delle
// «versioni in giro» come se fosse una versione, e fa marcare «indietro» una macchina che sta solo
// senza il dato. Il riconoscimento è sulla FORMA (`algo:esadecimale`, oppure un esadecimale lungo) e
// non sulla parola: la parola la scrive uno script che non è questo, e un giorno la cambia.
const FORMA_DIGEST = /^(?:[a-z0-9]+:)?[A-Fa-f0-9]{12,}$/
export const versioneNota = (immagine) => FORMA_DIGEST.test(String(immagine ?? '').trim())

// `sha256:45486f792f3f2a…` → `45486f792f3f`. Il prefisso è identico su ogni riga: occupa la colonna
// per niente, e sono i caratteri che servirebbero a distinguere due immagini a colpo d'occhio.
// Quello che non è un digest torna vuoto: chi chiama mostra «non dichiarata», che è l'informazione
// giusta, invece di stampare mezza parola come se fosse una versione.
export function digestCorto(immagine, quanti = 12) {
  if (!versioneNota(immagine)) return ''
  const nudo = String(immagine ?? '').replace(/^[a-z0-9]+:/i, '')
  return nudo.slice(0, quanti)
}

// L'immagine con cui si confrontano le altre, e da DOVE viene, che è la parte che cambia tutto:
//
//  · `config`: la versione attesa è scritta nella config del dev-env. Allora «indietro» è un fatto, e
//    se NESSUNA macchina ce l'ha vuol dire che sono indietro tutti, che è il caso che il ripiego qui
//    sotto non può vedere.
//  · `vista`: nessuna versione attesa, quindi si usa quella dell'avvio più recente registrato. È «la
//    più nuova che qualcuno ha visto», non «la più nuova che esiste»: se nessuno ha aggiornato, tutti
//    risultano pari. Il ripiego resta perché senza config è meglio di niente, ma la pagina deve DIRE
//    quale delle due sta usando, sennò la stessa colonna vuol dire due cose diverse.
//
// Le macchine arrivano ordinate per `quando` decrescente (lo fa il server); qui non si assume, si
// cerca il massimo, perché una funzione che dipende dall'ordine di chi la chiama si rompe in silenzio.
export function immagineRiferimento(macchine = [], attesa = null) {
  if (attesa) return { immagine: attesa, fonte: 'config' }
  let piuRecente = null
  for (const m of macchine) {
    if (!versioneNota(m?.immagine)) continue
    if (!piuRecente || (m.quando ?? 0) > (piuRecente.quando ?? 0)) piuRecente = m
  }
  return { immagine: piuRecente?.immagine ?? null, fonte: 'vista' }
}

// ── La DATA dell'immagine, che è quel che rende «indietro» un fatto ────────────────────────────────
//
// Il digest non ha un ORDINE: fra `45486f79` e `36b245a8` non si sa quale sia il più nuovo, e
// confrontarli con quello dell'avvio più recente fa eleggere il riferimento dall'orologio di chi avvia
// (il 31/08/2026 la pagina accusava quattro macchine su cinque, fra cui una che aveva l'immagine più
// nuova di quella eletta). Una data invece si ordina, quindi «indietro di otto giorni» è vero da solo,
// senza bisogno che qualcuno abbia la versione più nuova che esista.
//
// La manda l'avvio, letta dal label OCI sull'host e dal file che l'immagine si porta dentro (dal
// container il label non si legge, non c'è docker). Per chi non ha ancora aggiornato il dev-env il
// campo non c'è: allora non si dice niente, invece di indovinare.
export const dataImmagine = (m) => {
  const t = Date.parse(String(m?.creata ?? ''))
  return Number.isFinite(t) ? t : null
}

// La data che conta per «indietro» in una riga del heartbeat: la PIÙ VECCHIA fra l'immagine del
// container (`creata`) e quella da cui vengono i file della root (`file_creata`, dal 10/10/2026). Il
// container da solo mentiva: `docker compose up` lo porta all'ultima immagine scaricata anche senza
// update, e la pagina dava aggiornati Mac con script e config fermi a giorni prima. Senza `file_creata`
// (dev-env di prima) resta `creata`, come sempre.
export function creataEffettiva(r) {
  const c = r?.creata ?? null
  const f = r?.file_creata ?? null
  const tc = Date.parse(String(c ?? ''))
  const tf = Date.parse(String(f ?? ''))
  if (!Number.isFinite(tf)) return c
  if (!Number.isFinite(tc)) return f
  return tf < tc ? f : c
}

// La data più recente vista: è un massimo su un insieme ordinato, non una scelta fra pari.
export function dataRiferimento(macchine = []) {
  let max = null
  for (const m of macchine) {
    const t = dataImmagine(m)
    if (t != null && (max == null || t > max)) max = t
  }
  return max
}

// Di quanti GIORNI interi è indietro quella macchina. `null` quando una delle due date manca, e `0`
// quando sono dello stesso giorno: sotto le 24 ore non è «indietro», è la stessa immagine ricostruita,
// e chiamarlo indietro farebbe suonare ogni rebuild.
export function giorniIndietro(m, riferimento) {
  const mia = dataImmagine(m)
  if (mia == null || riferimento == null) return null
  return Math.floor((riferimento - mia) / 86_400_000)
}

// Quanti giorni di ritardo contano come «indietro». Sette e non uno: l'immagine si ricostruisce a ogni
// modifica del dev-env, quindi due giorni di ritardo sono il caso normale di chi ha lavorato ieri, e
// una soglia bassa farebbe suonare ogni rebuild. Una settimana e' il punto in cui il ritardo spiega
// davvero un «a me non funziona».
export const GIORNI_INDIETRO = 7

// «Indietro» come FATTO, in ordine di forza: la versione attesa dalla config quando c'e', altrimenti
// la data di costruzione, e in mancanza di entrambe non si accusa nessuno.
// `soglia` e' quella della config (`teleport.soglieDevEnv.giorniIndietro`) quando chi chiama ce l'ha.
export function ritardo(m, riferimento, dataRif, soglia = GIORNI_INDIETRO) {
  if (macchinaIndietro(m, riferimento)) return { indietro: true, giorni: giorniIndietro(m, dataRif) }
  const g = giorniIndietro(m, dataRif)
  if (g != null && g >= soglia) return { indietro: true, giorni: g }
  return { indietro: false, giorni: g }
}

// «Indietro» è un'accusa, e si può fare solo con la versione ATTESA in mano.
//
// ⚠️ Misurato sui dati veri il 31/08/2026, ed è la ragione di questa firma: con cinque macchine e
// cinque digest diversi, il ripiego («la più recente vista») elegge il riferimento con l'OROLOGIO, e
// il risultato era falso. Alle 12:37 una macchina aveva avviato l'immagine `36b245a8`, alle 12:42
// un'altra la `45486f79`, che era stata pubblicata PRIMA: la seconda diventava il riferimento e la
// prima veniva marcata «indietro» pur avendo l'immagine più nuova. Quattro righe su cinque accusate
// da un ordine di avvio. Quindi: `fonte: 'config'` accusa, `fonte: 'vista'` dice solo «diversa».
// Accetta anche un digest nudo (senza la fonte) per retro-compatibilità, e in quel caso NON accusa.
export function macchinaIndietro(m, riferimento) {
  const fonte = typeof riferimento === 'object' && riferimento ? riferimento.fonte : null
  if (fonte !== 'config') return false
  const atteso = riferimento.immagine
  return Boolean(atteso && versioneNota(m?.immagine) && m.immagine !== atteso)
}


// La macchina non ha dichiarato la versione: non è indietro, non è pari, è senza il dato.
export const senzaVersione = (m) => !versioneNota(m?.immagine)

// Un avvio con esito diverso da `ok` è una macchina che è partita male, e va detto anche se il resto
// della riga sembra sano. `null` (heartbeat vecchio, senza il campo) NON è un avvio storto: inventare
// un problema dove il dato manca è peggio che non dirlo.
export const avvioStorto = (m) => Boolean(m?.esito && m.esito !== 'ok')

// «Tutti indietro»: la versione attesa la sa la config e non ce l'ha NESSUNA macchina. Senza versione
// attesa la domanda non si può porre, e la risposta è `false` (non «sì per prudenza»: un allarme che
// non sa distinguere è un allarme che si impara a ignorare).
export function tuttiIndietro(macchine = [], riferimento) {
  if (!riferimento || riferimento.fonte !== 'config') return false
  const conImmagine = macchine.filter((m) => versioneNota(m?.immagine))
  return conImmagine.length > 0 && conImmagine.every((m) => m.immagine !== riferimento.immagine)
}

// Le app che pesano di piu' dentro al container, in MB: «backend 1,3 GB» dice dove guardare quando la
// VM e' piena. «altro» (gli MCP, i tool) non e' un'app e resta fuori.
//
// Dal 08/10/2026 la salute manda anche `app` (vedi `processiPerApp`): per un servizio che c'e' li', i MB
// sono quelli e la voce porta anche i processi e le categorie; `app_mb` resta il ripiego per i Mac che
// non lo mandano, e per i servizi che `app` non nomina. `quante` puo' essere `Infinity` (tutte).
export function appPiuPesanti(appMb = {}, quante = 2, app = null) {
  const mb = Object.fromEntries(Object.entries(appMb ?? {}).map(([nome, v]) => [nome, Number(v)]))
  for (const [nome, a] of Object.entries(app ?? {})) if (Number.isFinite(a?.mb)) mb[nome] = a.mb
  return Object.entries(mb)
    .filter(([nome, v]) => nome !== 'altro' && v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, quante)
    .map(([nome, v]) => {
      const voce = { nome, gb: Math.round(v / 102.4) / 10 }
      const a = app?.[nome]
      return a ? { ...voce, mb: a.mb, processi: a.processi, categorie: a.categorie } : voce
    })
}

// ── Cosa gira dentro a un'app (dal 08/10/2026) ────────────────────────────────────────────────────
//
// `app_mb` dice solo il totale: «il backend tiene 9,9 GB» non dice se e' il server che cresce, una
// corsa di test, il reload o tre copie dello stesso servizio. La riga di salute ora porta, per
// servizio, i MB, quanti processi e, per CATEGORIA, quanti e quanti MB. Le categorie sono un elenco
// chiuso che sceglie il dev-env dalla riga di comando (che non esce mai dalla VM): una chiave fuori
// elenco diventa `altro`, cosi' un dev-env piu' nuovo non apre colonne che la pagina non sa dire.
// L'ordine e' quello in cui si disegnano i pezzi di una barra: prima il server, poi chi gli sta
// intorno, in fondo chi lancia e il resto. Fisso, cosi' lo stesso colore sta sempre nello stesso posto.
export const CATEGORIE_PROCESSI = Object.freeze(['uvicorn', 'node', 'reload', 'worker', 'test', 'build', 'python', 'avvio', 'altro'])

const intero = (x) => {
  if (x === null || x === undefined || x === '' || typeof x === 'boolean') return null
  const n = Number(x)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

// `{ backend: { mb, processi, categorie: { uvicorn: { n, mb } } } }` → la stessa forma, coi numeri
// controllati e le categorie in un elenco nell'ordine fisso. `null` quando il blocco non c'e' o non
// dice niente (un Mac vecchio): «non lo so», non «nessun processo».
export function processiPerApp(app) {
  if (!app || typeof app !== 'object' || Array.isArray(app)) return null
  const fuori = {}
  for (const [nome, v] of Object.entries(app)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const perCat = {}
    const cat = v.categorie && typeof v.categorie === 'object' && !Array.isArray(v.categorie) ? v.categorie : {}
    for (const [c, x] of Object.entries(cat)) {
      const k = CATEGORIE_PROCESSI.includes(c) ? c : 'altro'
      const n = intero(x?.n)
      const mb = intero(x?.mb)
      if (n == null && mb == null) continue
      const prima = perCat[k] ?? { n: 0, mb: 0 }
      perCat[k] = { n: prima.n + (n ?? 0), mb: prima.mb + (mb ?? 0) }
    }
    const categorie = CATEGORIE_PROCESSI.filter((k) => perCat[k]).map((k) => ({ cat: k, ...perCat[k] }))
    const mb = intero(v.mb) ?? (categorie.length ? categorie.reduce((s, c) => s + c.mb, 0) : null)
    if (mb == null) continue
    fuori[nome] = { mb, processi: intero(v.processi), categorie }
  }
  return Object.keys(fuori).length ? fuori : null
}

// Lo stato del LANCIATORE delle app (lo script del dev-env che le avvia, anche in piu' copie con porte
// diverse): i servizi accesi sull'istanza standard, quante copie IN PIU', quali servizi su ognuna, e
// se il server delle copie gira col reload (`null`: non si sa).
//
// Il blocco si riconosce dalla FORMA (`servizi` elenco, e `copie` o `copie_servizi`) e non dal nome
// della chiave: il nome lo sceglie il dev-env di chi installa, e questo repo non lo deve sapere.
export function bloccoLanciatore(salute) {
  if (!salute || typeof salute !== 'object') return null
  for (const v of Object.values(salute)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.servizi) && ('copie' in v || 'copie_servizi' in v)) return v
  }
  return null
}

export function statoCopie(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const nomi = (xs) => (Array.isArray(xs) ? [...new Set(xs.filter((x) => x != null && x !== '').map(String))] : null)
  const servizi = nomi(raw.servizi)
  const copieServizi = {}
  if (raw.copie_servizi && typeof raw.copie_servizi === 'object' && !Array.isArray(raw.copie_servizi)) {
    for (const [n, xs] of Object.entries(raw.copie_servizi)) {
      const l = nomi(xs)
      if (l) copieServizi[n] = l
    }
  }
  const quante = Object.keys(copieServizi).length
  const copie = intero(raw.copie) ?? (quante ? quante : null)
  if (servizi == null && copie == null) return null
  return { servizi, copie, copieServizi, reload: raw.reload === true ? true : raw.reload === false ? false : null }
}

// ── La DIAGNOSI di un'app troppo pesante ──────────────────────────────────────────────────────────
//
// Quando un'app passa la soglia, la causa probabile a parole, dalle categorie e dalle copie. Le regole,
// nell'ordine in cui si dicono (la prima decide l'azione):
//   · una categoria tiene almeno il 70% dell'app: «pesa uvicorn», il processo stesso che cresce (se la
//     categoria e' `test` o `reload` la causa ha il nome di quelle due, qui sotto);
//   · i test tengono almeno il 40%: una corsa di test in corso;
//   · il reload (il processo che guarda i file) tiene almeno il 25% dell'app, o un giga da solo;
//   · due copie o piu' del lanciatore accese: ogni copia ha il suo server.
// Nessuna regola: l'elenco e' vuoto, e la pagina dice solo il peso (meglio che una causa inventata).
export const SOGLIE_DIAGNOSI = Object.freeze({ categoria: 0.7, test: 0.4, reload: 0.25, reloadMb: 1024, copie: 2 })

export function diagnosiApp(a, copie = null) {
  const cause = []
  const tot = Number.isFinite(a?.mb) ? a.mb : Number.isFinite(a?.gb) ? a.gb * 1024 : null
  const cat = a?.categorie ?? []
  const gbDi = (mb) => Math.round(mb / 102.4) / 10
  const voce = (k, c) => ({ k, cat: c.cat, n: c.n, gb: gbDi(c.mb), quota: Math.round((c.mb / tot) * 100) / 100 })
  if (tot > 0 && cat.length) {
    const quota = (c) => c.mb / tot
    const top = [...cat].sort((x, y) => y.mb - x.mb)[0]
    if (quota(top) >= SOGLIE_DIAGNOSI.categoria) cause.push(voce(top.cat === 'test' || top.cat === 'reload' ? top.cat : 'categoria', top))
    const test = cat.find((c) => c.cat === 'test')
    if (test && quota(test) >= SOGLIE_DIAGNOSI.test && !cause.some((c) => c.k === 'test')) cause.push(voce('test', test))
    const rel = cat.find((c) => c.cat === 'reload')
    if (rel && (quota(rel) >= SOGLIE_DIAGNOSI.reload || rel.mb >= SOGLIE_DIAGNOSI.reloadMb) && !cause.some((c) => c.k === 'reload')) cause.push(voce('reload', rel))
  }
  if (Number(copie?.copie) >= SOGLIE_DIAGNOSI.copie) cause.push({ k: 'copie', n: copie.copie, quali: Object.keys(copie.copieServizi ?? {}) })
  return cause
}

// Quel che la riga di salute dice dal 07/10/2026 sul COME si usa il dev-env: il motore di Docker, la
// memoria che la VM dovrebbe avere, gli opt-out accesi, i KO dell'ultimo doctor e i comandi dei repo
// lanciati sul Mac. Un campo che manca resta vuoto (`null`, `[]`, `0`): la cella non mostra niente,
// invece di un numero che sembri un fatto. `motoreIncerto`: un engine nudo senza il campo `motore`,
// cioe' colima o OrbStack senza sapere quale.
export function usoDellaMacchina(sm) {
  const cm = sm?.comandiMac ?? null
  const bloccati = Number(cm?.bloccati) || 0
  const forzati = Number(cm?.forzati) || 0
  return {
    motore: sm?.motore ?? null,
    motoreIncerto: !sm?.motore && (sm?.motoreCandidati ?? []).length > 1,
    obiettivoGb: sm?.vmMemObiettivoGb ?? null,
    optOut: [...new Set(sm?.optOut ?? [])].sort(),
    doctorKo: Number(sm?.doctor?.ko) > 0 ? Number(sm.doctor.ko) : 0,
    doctorFalliti: sm?.doctor?.falliti ?? [],
    sulMac: bloccati + forzati,
    bloccati,
    forzati,
  }
}
