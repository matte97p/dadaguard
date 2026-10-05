// Il numero di login falliti per il riepilogo della home, preso dallo STESSO payload della pagina
// Accessi (audit Teleport): una seconda lettura dell'audit darebbe un numero diverso da quello che la
// pagina mostra un clic dopo. `null` quando l'audit non e' configurato o non si e' letto: «non lo so»
// non e' zero. Pura/testabile.
export function riepilogoLogin(stato = {}) {
  const a = stato?.audit
  if (!stato?.configurato || !a || a.errore || a.loginFallite == null) return { loginFalliti: null, ore: a?.ore ?? null }
  const chi = (a.persone ?? []).filter((p) => p.loginFallite > 0).map((p) => p.utente)
  return { loginFalliti: a.loginFallite, persone: chi, ore: a.ore ?? null, troncato: !!a.troncato, motivo: a.motivoPiuComune?.motivo ?? null }
}
