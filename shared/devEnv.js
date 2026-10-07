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
export function appPiuPesanti(appMb = {}, quante = 2) {
  return Object.entries(appMb)
    .filter(([nome, mb]) => nome !== 'altro' && Number(mb) > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, quante)
    .map(([nome, mb]) => ({ nome, gb: Math.round(Number(mb) / 102.4) / 10 }))
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
