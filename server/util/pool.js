// Esegue `fn` su ogni item con al massimo `limit` in parallelo, preservando l'ordine dei risultati.
// Serve a NON aprire 100+ chiamate AWS contemporaneamente (throttling/limiti) quando i servizi
// monitorati sono tanti: il fetch-on-load resta, ma a ondate controllate.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  const n = Math.max(1, Math.min(limit, items.length || 1))
  await Promise.all(Array.from({ length: n }, worker))
  return results
}
