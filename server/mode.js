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
// Il discriminante è la PRESENZA di DADAGUARD_CONFIG: in cloud lo inietta SSM, in locale non c'è.
export const MODE = process.env.DADAGUARD_CONFIG ? 'cloud' : 'local'
export const isCloud = MODE === 'cloud'
export const isLocal = MODE === 'local'

// Cosa può fare la dashboard in questa modalità — una sola tabella, niente `if (env)` sparsi.
// Tutto ciò che è `false` in cloud richiede un filesystem scrivibile o il repo Terraform locale.
// I segnali di sola lettura (liveness, runtime, versione, secret-by-name, drift leggero, sprechi,
// costi, topologia) sono SEMPRE disponibili e non compaiono qui.
export const capabilities = {
  watchlist: isLocal, // add/remove servizi = scrive services.yaml
  discover: isLocal, // "Scopri servizi" → a valle scrive la watchlist
  fullDrift: isLocal, // `terragrunt plan` → serve il repo locale (repoDir)
}
