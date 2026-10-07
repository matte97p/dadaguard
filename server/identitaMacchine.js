// CHI E' UN MAC, quando il suo nome cambia (dal 07/10/2026).
//
// Perche' serve. La pagina Flotta mostrava lo stesso Mac due o tre volte. Sui dati veri di una
// settimana: un portatile comparso come `MacBook-Pro-di-X` fino alle 17:51 e come `MBP-di-X` dalle
// 18:44 (macOS rinomina l'host quando cambia rete, e `hostname -s` gli va dietro); un altro con tre
// nomi in sette giorni, uno dei quali e' il nome di default `Mac`. E anche la PERSONA non sta ferma:
// quando il dev-env non riesce a leggere l'utente Teleport ripiega su quello del sistema, quindi lo
// stesso Mac arriva come `kim42x` e come `kim`.
//
// Dal 07/10/2026 il dev-env manda due campi in piu' su ogni riga (heartbeat e salute):
//   · `macchina_id`: un hash esadecimale stabile per tutta la vita del Mac. Quando c'e', e' LUI che
//     dice chi e' il Mac: due nomi con lo stesso id sono lo stesso Mac anche se le date si
//     sovrappongono, e due nomi con id diversi sono due Mac anche se tutto il resto li unirebbe;
//   · `utente_da`: `teleport` | `cache` | `sistema`, cioe' quanto ci si puo' fidare di `utente`.
// Le righe vecchie non li hanno, e restano per sette giorni: i due campi sono facoltativi ovunque.
//
// ── L'EURISTICA per le righe senza id ─────────────────────────────────────────────────────────────
// Due nomi diventano un Mac solo quando valgono TUTTE queste condizioni:
//   1. la stessa persona: lo stesso utente (senza maiuscole), oppure lo stesso nome nella mappa delle
//      persone della config (`people`), oppure un utente di SISTEMA che e' il prefisso (almeno 4
//      lettere) del login Teleport (`kim` e `kim42x`). Vale per OGNI coppia di utenti dei due nomi;
//   2. gli intervalli [prima riga, ultima riga] non si sovrappongono, salvo `TOLLERANZA_MS`: un Mac
//      rinominato smette di parlare col nome vecchio e comincia col nuovo;
//   3. non stanno parlando tutti e due ADESSO (ultima riga di entrambi negli ultimi `IN_PARALLELO_MS`);
//   4. il candidato e' UNO solo: se un nome nuovo potrebbe continuare due Mac diversi della stessa
//      persona, non si sceglie a caso e resta da solo.
// Cosa NON unisce, apposta:
//   · due Mac veri usati in parallelo dalla stessa persona (il portatile e il fisso): parlano nelle
//     stesse ore, quindi gli intervalli si sovrappongono e la condizione 2 li tiene separati;
//   · un nome che va e torna (casa, ufficio, casa): gli intervalli si sovrappongono anche li', e resta
//     un doppione. Smette di contare dopo tre giorni di silenzio (vedi `NON_VISTA_MS`), che e' il modo
//     in cui spariscono quasi tutti i nomi vecchi;
//   · due persone diverse col Mac chiamato `Mac`: la condizione 1 le tiene separate.
// Sbagliare per difetto lascia un doppione che si spegne da solo; sbagliare per eccesso attribuisce i
// guasti di un Mac a un altro, ed e' l'errore che non si vede. Per questo l'euristica e' stretta.
//
// ⚠️ Limite noto: i dati a monte (heartbeat e salute) sono raggruppati per NOME. Due Mac diversi con lo
// stesso nome e id diversi restano una riga sola, come prima: l'id qui non li puo' separare, li
// riconosce solo (la riga ha due id in `ids`).
//
// Tutto puro: nessuna lettura, nessun «adesso» preso da dentro.

const ORA = 3_600_000
const GIORNO = 24 * ORA

// Un Mac che non manda niente da piu' di tre giorni non e' piu' nella flotta che si guarda: e' un nome
// vecchio (rinominato), o un portatile chiuso in un cassetto. Esce dai numeri e va in un gruppo chiuso.
export const NON_VISTA_MS = 3 * GIORNO
// Quanto possono sovrapporsi due nomi dello stesso Mac: due giri della salute (una riga ogni 15 minuti).
export const TOLLERANZA_MS = 30 * 60_000
// «Sta parlando adesso»: un'ultima riga piu' recente di cosi'.
export const IN_PARALLELO_MS = 30 * 60_000
// La lunghezza minima di un utente di sistema per essere il prefisso di un login Teleport.
export const MIN_PREFISSO = 4

const FORMA_ID = /^[0-9a-f]{8,64}$/

// L'id del Mac come lo manda il dev-env; qualsiasi altra forma e' «non lo so».
export function idMacchina(r) {
  const v = String(r?.macchina_id ?? '')
    .trim()
    .toLowerCase()
  return FORMA_ID.test(v) ? v : null
}

const FONTI = new Set(['teleport', 'cache', 'sistema'])
export const fonteUtente = (r) => (FONTI.has(r?.utente_da) ? r.utente_da : null)

// Annota UNA riga (heartbeat o salute) nella mappa `{ nome: { primo, ultimo, ids, utenti } }`.
// `utenti` tiene una voce per coppia utente/fonte, con l'istante piu' recente.
export function annotaIdentita(mappa, r, quando) {
  if (!r?.macchina || !Number.isFinite(quando)) return mappa
  const n = (mappa[r.macchina] ??= { primo: quando, ultimo: quando, ids: [], utenti: [] })
  n.primo = Math.min(n.primo, quando)
  n.ultimo = Math.max(n.ultimo, quando)
  const id = idMacchina(r)
  if (id && !n.ids.includes(id)) n.ids.push(id)
  if (r.utente) {
    const da = fonteUtente(r)
    const u = n.utenti.find((x) => x.utente === r.utente && x.da === da)
    if (u) u.quando = Math.max(u.quando, quando)
    else n.utenti.push({ utente: String(r.utente), da, quando })
  }
  return mappa
}

// Le identita' di piu' fonti (heartbeat, salute) per nome, in una.
export function fondiIdentita(...mappe) {
  const fuori = {}
  for (const m of mappe) {
    for (const [nome, x] of Object.entries(m ?? {})) {
      if (!x) continue
      const n = (fuori[nome] ??= { primo: x.primo ?? null, ultimo: x.ultimo ?? null, ids: [], utenti: [] })
      if (Number.isFinite(x.primo)) n.primo = n.primo == null ? x.primo : Math.min(n.primo, x.primo)
      if (Number.isFinite(x.ultimo)) n.ultimo = n.ultimo == null ? x.ultimo : Math.max(n.ultimo, x.ultimo)
      for (const id of x.ids ?? []) if (!n.ids.includes(id)) n.ids.push(id)
      for (const u of x.utenti ?? []) {
        const c = n.utenti.find((y) => y.utente === u.utente && y.da === u.da)
        if (c) c.quando = Math.max(c.quando ?? 0, u.quando ?? 0)
        else n.utenti.push({ ...u })
      }
    }
  }
  return fuori
}

const norm = (u) =>
  String(u ?? '')
    .trim()
    .toLowerCase()

// Il nome canonico nella mappa delle persone della config (`people`: identita' grezza → nome), come
// `canonicalActor` in server/util/principal.js; `null` se l'utente non c'e'.
export function personaMappata(utente, persone = null) {
  if (!persone || !utente) return null
  const k = norm(utente)
  for (const [grezzo, nome] of Object.entries(persone)) if (norm(grezzo) === k && nome) return String(nome)
  return null
}

// Due voci utente (`{ utente, da }`) sono la stessa persona? Vedi la condizione 1 in cima.
export function stessaPersona(a, b, persone = null) {
  const x = norm(a?.utente)
  const y = norm(b?.utente)
  if (!x || !y) return false
  if (x === y) return true
  const ma = personaMappata(a.utente, persone)
  const mb = personaMappata(b.utente, persone)
  if ((ma || mb) && norm(ma ?? a.utente) === norm(mb ?? b.utente)) return true
  // Il ripiego del dev-env e' l'utente di SISTEMA, che e' spesso l'inizio del login Teleport. Il corto
  // non deve essere un login Teleport (due login Teleport diversi sono due persone) e il lungo non deve
  // essere un utente di sistema. Senza `da` (righe vecchie) non si sa, e vale.
  const [corto, lungo] = x.length <= y.length ? [a, b] : [b, a]
  const c = norm(corto.utente)
  if (c.length < MIN_PREFISSO || !norm(lungo.utente).startsWith(c)) return false
  return corto.da !== 'teleport' && corto.da !== 'cache' && lungo.da !== 'sistema'
}

// La PERSONA di un Mac, dalle voci di tutti i suoi nomi:
//   1. l'utente della riga piu' recente con `utente_da = teleport` (poi `cache`, che e' il login
//      Teleport ricordato dall'ultima sessione);
//   2. altrimenti un utente che la mappa delle persone conosce, col suo nome;
//   3. altrimenti l'utente della riga piu' recente, ma se e' il prefisso di un altro utente visto (il
//      ripiego di sistema di un login Teleport) quell'altro.
// `altri`: gli altri utenti visti, per il pannello.
export function personaDi(utenti = [], persone = null) {
  const voci = [...utenti].filter((u) => u?.utente).sort((a, b) => (b.quando ?? 0) - (a.quando ?? 0))
  if (!voci.length) return { utente: null, da: null, altri: [] }
  let scelta = null
  for (const fonte of ['teleport', 'cache']) {
    const v = voci.find((u) => u.da === fonte)
    if (v) {
      scelta = { utente: v.utente, da: fonte }
      break
    }
  }
  if (!scelta) {
    const v = voci.find((u) => personaMappata(u.utente, persone))
    if (v) scelta = { utente: personaMappata(v.utente, persone), da: 'mappa' }
  }
  if (!scelta) {
    const v = voci[0]
    const lungo = voci.find((u) => u !== v && stessaPersona(v, u, persone) && norm(u.utente).length > norm(v.utente).length && norm(u.utente).startsWith(norm(v.utente)))
    scelta = { utente: (lungo ?? v).utente, da: (lungo ?? v).da ?? null }
  }
  const altri = [...new Set(voci.map((u) => u.utente))].filter((u) => norm(u) !== norm(scelta.utente))
  return { ...scelta, altri }
}

const sovrapposti = (a, b, tolleranza) => Math.min(a.ultimo, b.ultimo) - Math.max(a.primo, b.primo) > tolleranza

// I NOMI raggruppati in Mac. Torna un gruppo per Mac: `nomi` dal piu' recente (il primo e' quello da
// mostrare), `ids`, `primo`, `ultimo`, e `come` (`id` se l'ha unito l'id, `euristica` se l'euristica,
// `null` se e' un nome solo). L'ordine dei gruppi non conta: lo decide chi mostra.
export function raggruppaMacchine(identita = {}, { adesso = Date.now(), persone = null, tolleranza = TOLLERANZA_MS, inParallelo = IN_PARALLELO_MS } = {}) {
  const nomi = Object.entries(identita)
    .filter(([, x]) => x && Number.isFinite(x.primo) && Number.isFinite(x.ultimo))
    .map(([nome, x]) => ({ nome, ...x }))
    .sort((a, b) => a.primo - b.primo || a.nome.localeCompare(b.nome))

  // 1. L'id: tutti i nomi che condividono un id sono un Mac, senza altre domande.
  const gruppi = []
  const perId = new Map()
  for (const n of nomi) {
    const giaSuoi = [...new Set(n.ids.map((id) => perId.get(id)).filter(Boolean))]
    let g = giaSuoi[0]
    if (!g) {
      g = { membri: [], ids: new Set(), come: null }
      gruppi.push(g)
    }
    // Un nome con due id che erano in due gruppi li fonde (lo stesso Mac visto con due nomi diversi
    // prima e dopo): raro, ma senza questo dipenderebbe dall'ordine.
    for (const altro of giaSuoi.slice(1)) {
      g.membri.push(...altro.membri)
      for (const id of altro.ids) g.ids.add(id)
      gruppi.splice(gruppi.indexOf(altro), 1)
    }
    g.membri.push(n)
    for (const id of n.ids) g.ids.add(id)
    for (const id of g.ids) perId.set(id, g)
    if (g.membri.length > 1) g.come = 'id'
  }

  // 2. L'euristica, sui gruppi in ordine di prima riga: ognuno cerca UN gruppo precedente da continuare.
  const primo = (g) => Math.min(...g.membri.map((m) => m.primo))
  const ultimo = (g) => Math.max(...g.membri.map((m) => m.ultimo))
  const utentiDi = (g) => g.membri.flatMap((m) => m.utenti ?? [])
  const compatibili = (a, b) => {
    // Due id diversi sono due Mac: l'id vince sul nome.
    if (a.ids.size && b.ids.size) return false
    const ua = utentiDi(a)
    const ub = utentiDi(b)
    if (!ua.length || !ub.length) return false
    if (!ua.every((x) => ub.every((y) => stessaPersona(x, y, persone)))) return false
    if (a.membri.some((x) => b.membri.some((y) => sovrapposti(x, y, tolleranza)))) return false
    if (adesso - ultimo(a) < inParallelo && adesso - ultimo(b) < inParallelo) return false
    return true
  }
  const ordinati = [...gruppi].sort((a, b) => primo(a) - primo(b))
  const fuori = []
  for (const g of ordinati) {
    const candidati = fuori.filter((f) => compatibili(f, g))
    if (candidati.length === 1) {
      const f = candidati[0]
      f.membri.push(...g.membri)
      for (const id of g.ids) f.ids.add(id)
      // Basta un'unione per euristica perche' il Mac intero sia «unito per euristica»: e' la piu' debole.
      f.come = 'euristica'
      continue
    }
    fuori.push(g)
  }

  return fuori.map((g) => {
    const membri = [...g.membri].sort((a, b) => b.ultimo - a.ultimo || a.nome.localeCompare(b.nome))
    return {
      nomi: membri.map((m) => m.nome),
      ids: [...g.ids].sort(),
      primo: primo(g),
      ultimo: ultimo(g),
      utenti: utentiDi(g),
      come: membri.length > 1 ? g.come : null,
    }
  })
}
