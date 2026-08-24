// Nome visualizzato di un servizio. Per i modelli Bedrock rende leggibile l'ID grezzo
// (eu.anthropic.claude-sonnet-4-5-20250929-v1:0 → "Claude Sonnet 4.5"); per gli altri = il nome AWS.
// Condiviso tra card, ricerca (filtro nome), palette ⌘K → così cerchi ciò che VEDI.
//
// Qui vive anche lo SPLIT del nome in "famiglia + coda" (vedi splitFamily): i nomi AWS reali sono
// lunghi e quasi tutti uguali in testa (acme-staging-cron-…) — la card mostra la testa piccola e
// muta e la coda in evidenza, senza nascondere nulla.

// PROFILI DI INFERENZA riconosciuti come prefisso di un ID Bedrock. `global` è nell'elenco per un
// motivo preciso: prima non lo era, quindi da `global.anthropic.claude-opus-5` non si ricavava nessuna
// etichetta — e siccome il nome accorciato è identico a quello del gemello `eu.`, in tabella
// comparivano due righe indistinguibili nello stesso ambiente. Il prefisso NON è un dettaglio
// cosmetico: dice dove gira l'inferenza, e `global` può uscire dall'Unione Europea.
const INFERENCE_SCOPES = /^(eu|us|apac|ap|ca|sa|global)$/i

export function prettyBedrock(id) {
  const raw = String(id ?? '')
  const regionM = raw.match(/^([a-z0-9]+)\./i)
  const s = raw.replace(/^[a-z0-9]+\./i, '').replace(/^[a-z0-9]+\./i, '') // toglie region + provider
  const dateM = s.match(/-(\d{8})(?:-v[\d:]+)?$/)
  const base = dateM ? s.slice(0, dateM.index) : s.replace(/-v[\d:]+$/, '')
  if (!base) return { name: raw }
  const name = base
    .replace(/(\d)-(\d)/g, '$1.$2')
    .split('-')
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
  const scope = INFERENCE_SCOPES.test(regionM?.[1] ?? '') ? regionM[1].toLowerCase() : null
  const date = dateM ? `${dateM[1].slice(0, 4)}-${dateM[1].slice(4, 6)}-${dateM[1].slice(6, 8)}` : null
  return { name, scope, meta: [scope, date].filter(Boolean).join(' · ') }
}

// Un profilo di inferenza fuori dall'area UE va detto, non lasciato dedurre da un prefisso: il
// contratto ammette solo `eu.*`, e `global.*` può instradare l'inferenza fuori dall'Unione Europea.
// Un ID senza prefisso riconosciuto non è "fuori area": è ignoto, e affermarlo sarebbe inventare.
export function isNonEuInference(service) {
  if (service?.type !== 'bedrock') return false
  const { scope } = prettyBedrock(service.name)
  return Boolean(scope) && scope !== 'eu'
}

// IDENTITÀ di un servizio nella UI: account + region + tipo + nome. Il nome da solo NON identifica
// niente: `backend` esiste in staging e in produzione, e i modelli Bedrock in entrambi. Cercare per
// nome apre la card dell'altro ambiente, e con essa i suoi numeri e i suoi log: la tabella dice "234
// invocazioni, 1 errore 5xx" su produzione e il pannello risponde "nessuna invocazione" perché sta
// guardando staging.
//
// Nemmeno account + nome basta, e non per un caso di scuola: DENTRO un account lo stesso nome torna
// più volte. La discovery fa un candidato per RISORSA (`server/discover.js`), e una risorsa ECS, il
// suo ALB e il suo autoscaling group portano lo stesso nome AWS; e lo sweep multi-region
// (`server/autodiscover.js`) rilegge quel nome in ogni region. Il payload dello stato non ha ID di
// risorsa: quello che distingue quelle righe è `region` e `type`, quindi stanno nella chiave.
//
// Il prezzo di sbagliarla non è cosmetico: questa chiave è il `rowKey` della tabella, e chiavi
// duplicate lasciano RIGHE FANTASMA. React tiene una voce per chiave, quindi dei fratelli omonimi ne
// cancella uno solo: gli altri restano appesi nel DOM col loro stato di prima, e filtrando "giù" si
// vedevano tre righe verdi sotto un contatore che diceva "3/107" (cioè: nei dati filtrati non
// c'erano). Stessa chiave apre il pannello, e con gli omonimi apriva sempre il primo trovato.
// Quando il server sa QUALE risorsa è (`resourceId` = account|tipo|cluster/arn/asg…) si usa quella:
// è l'unica cosa che separa due servizi ECS omonimi in cluster diversi dello stesso account e della
// stessa region, che su account, region, tipo e nome sono identici. Il ripiego serve ai servizi
// dichiarati a mano senza identificatori di risorsa, e ai payload di una versione precedente del
// server (una UI aggiornata può parlare con un server che non manda ancora il campo).
//
// L'account arriva come oggetto `{key,label,color}` dal payload della UI e come stringa dal
// risolutore del server: si normalizza come fanno `nodeIdOf` e `acctKey`, perché una chiave costruita
// sull'oggetto diventa "[object Object]" per tutti gli account e le collisioni tornano tutte insieme.
export function serviceKey(service) {
  const acct = service?.account
  const account = (typeof acct === 'string' ? acct : acct?.key) ?? '—'
  if (service?.resourceId) return `${account}/${service.resourceId}`
  const region = service?.region ?? '—'
  const type = service?.type ?? '—'
  return `${account}/${region}/${type}/${service?.name ?? ''}`
}

// Nome leggibile per la UI. Ritorna sempre una stringa.
export function displayName(service) {
  if (service?.type === 'bedrock') return prettyBedrock(service.name).name || service.name
  return service?.name ?? ''
}

// PREFISSI DI FAMIGLIA condivisi in un gruppo di nomi: `acme-staging-cron-…` ripetuto su 14 card è
// rumore che schiaccia la parte che DISTINGUE davvero. Qui contiamo, sui confini `-`, quali prefissi
// tornano abbastanza spesso da essere una "famiglia" del gruppo.
//
// Soglia = UN TERZO del gruppo (minimo 2), non "tutti", non "almeno 2" e non "metà":
//  · "tutti" → un solo outlier (reporting-staging-db tra i acme-*) fa perdere la compattazione a tutti;
//  · "almeno 2" → due soli fratelli diventano famiglia (…cron-scraped- accanto a …cron-) e ogni card
//    mostra una testa diversa, mangiandosi anche una parola che serve a capire il nome. La testa muta
//    funziona solo se è LA STESSA su tutto il gruppo: l'occhio la salta una volta e non ci torna;
//  · "metà" → troppo severa sulle flotte vere: un account con 21 servizi di cui 12 `acme-staging-`
//    (57%) e 9 `acme-staging-cron-` (43%) non compattava NIENTE. Un terzo tiene entrambe le teste.
// Con un terzo possono convivere 2-3 famiglie sorelle in un gruppo, ma a quel peso sono famiglie vere.
// I prefissi che sopravvivono sono innestati (acme-staging- ⊂ acme-staging-cron-): splitFamily prende
// il più lungo che combacia, quindi i cron hanno la testa lunga e gli altri servizi quella corta.
// Il chiamante passa solo i nomi che una testa la possono usare (i Bedrock hanno il loro nome
// parlante): dentro il conteggio gonfierebbero il denominatore e alzerebbero la soglia per tutti.
export function familyPrefixes(names = []) {
  const counts = new Map()
  for (const name of names) {
    const seg = String(name ?? '').split('-')
    for (let i = 1; i < seg.length; i++) {
      const p = seg.slice(0, i).join('-') + '-'
      counts.set(p, (counts.get(p) ?? 0) + 1)
    }
  }
  const floor = Math.max(2, Math.ceil(names.length / 3))
  return new Set([...counts].filter(([, n]) => n >= floor).map(([p]) => p))
}

// Divide un nome in { family, tail } usando i prefissi condivisi del gruppo (familyPrefixes).
// Senza famiglia (nome unico nel gruppo) → family null e tail = nome intero: niente resta nascosto.
export function splitFamily(name, prefixes) {
  const full = String(name ?? '')
  if (!prefixes?.size) return { family: null, tail: full }
  let best = null
  for (const p of prefixes) {
    if (full.startsWith(p) && full.length > p.length && (!best || p.length > best.length)) best = p
  }
  return best ? { family: best, tail: full.slice(best.length) } : { family: null, tail: full }
}
