// Gli stati di TRANSIZIONE di un target dietro un load balancer: quelli in cui il bersaglio sta
// ENTRANDO o USCENDO, non quelli in cui è rotto. Vive in un modulo suo, senza nessun import, perché la
// stessa distinzione la usano il server (che conta i target e decide il colore) e il web (che disegna
// il tag di stato nella tabella delle copie): due elenchi scritti a mano divergono, e sono divergenti
// in silenzio — la card dice «in transizione» e la riga sotto dice «errore», per lo stesso target.
//
// L'elenco viene da `TargetHealthStateEnum` dell'SDK ELBv2, che ha SETTE stati:
//   draining | healthy | initial | unavailable | unhealthy | unhealthy.draining | unused
//
// In transizione sono questi tre:
//   · `draining`            la copia vecchia sfilata a fine rilascio, finisce le richieste già aperte
//                           e sparisce dopo il `deregistration_delay` del target group (default 300s)
//   · `unhealthy.draining`  la stessa cosa, ma il container ha già smesso di rispondere all'health
//                           check mentre drena (dopo il SIGTERM): stesso motivo AWS
//                           `Target.DeregistrationInProgress`, e senza questo terzo stato il falso
//                           allarme rientrava dalla porta di servizio
//   · `initial`             la copia NUOVA, che deve ancora passare i primi health check
//
// Fuori restano gli altri quattro, e non per dimenticanza: `unhealthy` e `unavailable` sono guasti o
// configurazione, `unused` (`Target.NotInUse`) è un target group scollegato, e nessuno dei tre si
// risolve da sé aspettando.
export const TRANSIENT_TARGET_STATES = Object.freeze(['draining', 'unhealthy.draining', 'initial'])

const SET = new Set(TRANSIENT_TARGET_STATES)

export function isTransientTargetState(state) {
  return SET.has(state)
}
