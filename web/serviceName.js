// Nome visualizzato di un servizio. Per i modelli Bedrock rende leggibile l'ID grezzo
// (eu.anthropic.claude-sonnet-4-5-20250929-v1:0 → "Claude Sonnet 4.5"); per gli altri = il nome AWS.
// Condiviso tra card, ricerca (filtro nome), palette ⌘K → così cerchi ciò che VEDI.

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

// Nome leggibile per la UI. Ritorna sempre una stringa.
export function displayName(service) {
  if (service?.type === 'bedrock') return prettyBedrock(service.name).name || service.name
  return service?.name ?? ''
}
