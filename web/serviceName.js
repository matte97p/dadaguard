// Nome visualizzato di un servizio. Per i modelli Bedrock rende leggibile l'ID grezzo
// (eu.anthropic.claude-sonnet-4-5-20250929-v1:0 → "Claude Sonnet 4.5"); per gli altri = il nome AWS.
// Condiviso tra card, ricerca (filtro nome), palette ⌘K → così cerchi ciò che VEDI.
//
// Qui vive anche lo SPLIT del nome in "famiglia + coda" (vedi splitFamily): i nomi AWS reali sono
// lunghi e quasi tutti uguali in testa (cato-staging-cron-…) — la card mostra la testa piccola e
// muta e la coda in evidenza, senza nascondere nulla.

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
  const region = /^(eu|us|apac|ap|ca|sa)$/i.test(regionM?.[1]) ? regionM[1].toLowerCase() : null
  const date = dateM ? `${dateM[1].slice(0, 4)}-${dateM[1].slice(4, 6)}-${dateM[1].slice(6, 8)}` : null
  return { name, meta: [region, date].filter(Boolean).join(' · ') }
}

// IDENTITÀ di un servizio nella UI: account + nome. Il nome da solo NON identifica niente — `backend`
// esiste in staging e in produzione, e i modelli Bedrock in entrambi. Cercare per nome apre la card
// dell'altro ambiente, e con essa i suoi numeri e i suoi log: la tabella dice "234 invocazioni, 1
// errore 5xx" su produzione e il pannello risponde "nessuna invocazione" perché sta guardando staging.
export function serviceKey(service) {
  return `${service?.account?.key ?? '—'}/${service?.name ?? ''}`
}

// Nome leggibile per la UI. Ritorna sempre una stringa.
export function displayName(service) {
  if (service?.type === 'bedrock') return prettyBedrock(service.name).name || service.name
  return service?.name ?? ''
}

// PREFISSI DI FAMIGLIA condivisi in un gruppo di nomi: `cato-staging-cron-…` ripetuto su 14 card è
// rumore che schiaccia la parte che DISTINGUE davvero. Qui contiamo, sui confini `-`, quali prefissi
// tornano abbastanza spesso da essere una "famiglia" del gruppo.
//
// Soglia = UN TERZO del gruppo (minimo 2), non "tutti", non "almeno 2" e non "metà":
//  · "tutti" → un solo outlier (avvista-staging-db tra i cato-*) fa perdere la compattazione a tutti;
//  · "almeno 2" → due soli fratelli diventano famiglia (…cron-scraped- accanto a …cron-) e ogni card
//    mostra una testa diversa, mangiandosi anche una parola che serve a capire il nome. La testa muta
//    funziona solo se è LA STESSA su tutto il gruppo: l'occhio la salta una volta e non ci torna;
//  · "metà" → troppo severa sulle flotte vere: un account con 21 servizi di cui 12 `cato-staging-`
//    (57%) e 9 `cato-staging-cron-` (43%) non compattava NIENTE. Un terzo tiene entrambe le teste.
// Con un terzo possono convivere 2-3 famiglie sorelle in un gruppo, ma a quel peso sono famiglie vere.
// I prefissi che sopravvivono sono innestati (cato-staging- ⊂ cato-staging-cron-): splitFamily prende
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
