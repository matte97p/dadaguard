// Quali righe di log sono CONTORNO e quali no. Sta in un modulo suo, e non dentro `logline.jsx`, per
// due motivi: la usa il pannello dei log senza tirarsi dietro il rendering, e da qui è verificabile
// (`node --test` non sa importare un `.jsx`, quindi una regola sepolta lì dentro non ha prove).

// Righe di piattaforma Lambda: START/END/REPORT/INIT, nascoste di default.
const PLATFORM = /^(START|END|REPORT|INIT_START|XRAY) RequestId/

// ...tranne quando la riga porta il VERDETTO della run. Una Lambda uccisa DAL RUNTIME non scrive
// nessuna eccezione: memoria finita, timeout e processo morto li dichiara solo la `REPORT`
// (`Status: error`, `Error Type: Runtime.OutOfMemory`). Nasconderla insieme al resto del contorno
// svuotava il pannello proprio nel caso per cui lo apri, «perché è rosso?», e con "Solo errori" acceso
// era anche l'UNICA riga che il filtro lato server teneva: due default che si annullano a vicenda.
// Visto il 06/09/2026 su una Lambda schedulata in produzione: tre tentativi su tre in
// `Runtime.OutOfMemory` e «Nessun evento nella finestra» a schermo.
// `Status:` sulla REPORT vale per DIFFERENZA da `success`: i valori non sono solo `error`, ci sono
// almeno `timeout` e `failure`, e un elenco di quelli visti finora sarebbe una lista destinata a
// restare indietro sul valore nuovo, cioè a nascondere di nuovo il verdetto senza dirlo.
const VERDETTO = /\b(Status:\s*(?!success\b)\w+|Error Type:|Task timed out|Runtime exited with error)/i

export function isNoise(message) {
  const s = (message ?? '').trimStart()
  return PLATFORM.test(s) && !VERDETTO.test(s)
}
