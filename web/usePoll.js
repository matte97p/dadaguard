import { useCallback, useEffect, useRef, useState } from 'react'

// Fetch con auto-refresh "educato": ricarica `url` a intervallo, MA si mette in PAUSA quando il tab è
// nascosto (niente chiamate AWS sprecate quando non stai guardando) e rifà SUBITO il fetch al rientro
// nel tab / focus della finestra. Così la vista è sempre fresca quando la guardi, senza martellare AWS
// in background. On-demand read-only: nessuno stato lato server.
//
// Il PRIMO caricamento espone `loading` (per lo skeleton); i giri successivi aggiornano i dati IN PLACE
// (`refreshing`) senza farli sparire, e un errore transitorio non cancella i dati già mostrati.
// `lastUpdated` = timestamp (ms) dell'ultimo fetch riuscito, per l'indicatore "aggiornato Ns fa".
export function usePoll(url, { intervalMs = 20000, enabled = true } = {}) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false) // solo il primissimo caricamento (per lo skeleton)
  const [refreshing, setRefreshing] = useState(false) // giri successivi (indicatore discreto)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const hasData = useRef(false)

  const fetchOnce = useCallback(
    async (signal) => {
      if (hasData.current) setRefreshing(true)
      else setLoading(true)
      try {
        const r = await fetch(url, { signal })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        setData(await r.json())
        hasData.current = true
        setError(null)
        setLastUpdated(Date.now())
      } catch (e) {
        if (e.name === 'AbortError') return // fetch annullato (url cambiato / unmount): scartalo
        setError(e.message) // NON azzero `data`: meglio dati vecchi + errore che una pagina vuota
      } finally {
        if (!signal?.aborted) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    },
    [url],
  )

  useEffect(() => {
    if (!enabled) return undefined
    const controller = new AbortController()
    fetchOnce(controller.signal)

    let timer = null
    const tick = () => {
      if (!document.hidden) fetchOnce()
    }
    const start = () => {
      if (!timer) timer = setInterval(tick, intervalMs)
    }
    const stop = () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else {
        fetchOnce() // rientrato nel tab → fresco subito
        start() // ...e riprendi il polling
      }
    }

    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', tick)
    return () => {
      controller.abort()
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', tick)
    }
  }, [fetchOnce, intervalMs, enabled])

  return { data, loading, refreshing, error, lastUpdated, refresh: () => fetchOnce() }
}
