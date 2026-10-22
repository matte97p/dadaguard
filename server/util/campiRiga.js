// I campi di testo libero di una riga di #aws-deploy, ripuliti come li ripulisce la CI
// (`notifica-check-rossi` di cato-actions): la stessa riga esce in #aws-deploy dal webhook della CI e
// in #aws-deploy-status da qui, e due pulizie diverse la facevano leggere diversa (22/10/2026).
// Vengono da chi spinge su un ramo di rilascio, quindi sono dati non fidati: escape dei caratteri con
// cui Slack costruisce link e menzioni (un oggetto «togli <!channel>» taggherebbe il canale), niente
// backtick, una riga sola, tagliati. Vanno solo nella riga dell'allarme, mai sul canvas.

// `](` spezzato: `aMrkdwn` (quadro.js) trasforma `[testo](url)` in un link di Slack, e un oggetto del
// commit scritto così diventerebbe un link scelto da chi ha spinto.
const pulisci = (x, max) =>
  typeof x === 'string'
    ? x
        .split(/\r?\n/)[0]
        .replace(/`/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\]\(/g, '] (')
        .slice(0, max)
        .trim() || null
    : null

// L'oggetto del commit (90 caratteri, standard §4), senza il `(#753)` che aggiunge lo squash merge. Puro.
export const oggettoCommit = (x) => pulisci(typeof x === 'string' ? x.split(/\r?\n/)[0].replace(/ *\(#\d+\) *$/, '') : null, 90)

// Una riga d'errore (`column "y" does not exist`), 120 caratteri. Puro.
export const testoBreve = (x) => pulisci(x, 120)

// Chi ha spinto, come utente GitHub (standard §4): senza il prefisso numerico delle mail `noreply`
// (`81815192+matte97p@users.noreply.github.com` → `matte97p`). Solo un nome valido per GitHub, o niente. Puro.
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$/
export function autoreGithub(x) {
  if (typeof x !== 'string') return null
  const a = x.replace(/@.*$/, '').replace(/^[0-9]+\+/, '')
  return LOGIN.test(a) ? a : null
}
