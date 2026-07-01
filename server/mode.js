// Modalità d'esecuzione e capacità — UNICA fonte di verità. Tutto il resto chiede a questo
// modulo invece di ri-controllare `process.env.DADAGUARD_CONFIG` sparso per il codice.
//
// Due modalità, separate per davvero:
//
//   local-first — config dal file services.yaml; la dashboard può EDITARLO (watchlist),
//                 girare `terragrunt plan` (drift completo) e fare discovery. Pensata per
//                 il portatile dell'operatore, col repo Terraform a portata di mano.
//
//   cloud       — config iniettata da SSM (DADAGUARD_CONFIG), read-only: niente scrittura su
//                 file né repo locale → niente watchlist / drift-completo / discovery. È la
//                 modalità "quasi-SaaS": un container condiviso che solo LEGGE lo stato AWS.
//
//   demo        — DADAGUARD_DEMO=1: dataset finto, ZERO AWS. Per provarlo senza wiring,
//                 registrare la GIF di lancio, o valutare la UI. Tutto read-only e statico.
//
// Il discriminante è la PRESENZA di DADAGUARD_CONFIG: in cloud lo inietta SSM, in locale non c'è.
export const isDemo = Boolean(process.env.DADAGUARD_DEMO)
export const MODE = isDemo ? 'demo' : process.env.DADAGUARD_CONFIG ? 'cloud' : 'local'
export const isCloud = MODE === 'cloud'
export const isLocal = MODE === 'local'

// Auto-discovery PASSIVA (read-only, in memoria): scopre i servizi degli account e li unisce alla
// watchlist. Diversa dal pulsante "Scopri servizi" (capabilities.discover, che SCRIVE la watchlist
// ed è solo local): questa non scrive nulla → gira anche in cloud. ATTIVA DI DEFAULT (coerente con
// lo spirito zero-config di Dadaguard); opt-out esplicito con DADAGUARD_DISCOVER=0. Con watchlist
// vuota la discovery scatta comunque. Nota: gira a ogni /api/status (fetch-on-load), quindi con
// molti account/region aggiunge chiamate AWS read-only a ogni refresh.
export const autoDiscover = process.env.DADAGUARD_DISCOVER !== '0'

// Cosa può fare la dashboard in questa modalità — una sola tabella, niente `if (env)` sparsi.
// Tutto ciò che è `false` in cloud richiede un filesystem scrivibile o il repo Terraform locale.
// I segnali di sola lettura (liveness, runtime, versione, secret-by-name, drift leggero, sprechi,
// costi, topologia) sono SEMPRE disponibili e non compaiono qui.
export const capabilities = {
  watchlist: isLocal, // add/remove servizi = scrive services.yaml
  discover: isLocal, // "Scopri servizi" → a valle scrive la watchlist
  fullDrift: isLocal, // `terragrunt plan` → serve il repo locale (repoDir)
}
