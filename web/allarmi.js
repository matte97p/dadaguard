// Il motivo di un allarme CloudWatch in una frase che si legge, nella lingua della pagina.
//
// AWS scrive `StateReason` in inglese e a modo suo («Threshold Crossed: 1 out of the last 1
// datapoints [0.0 (25/11/26 12:29:00)] was less than the threshold (1.0) …»): vero, ma chi guarda la
// pagina Adesso non sa che «datapoint» e' una misura ne' cosa farne. Qui si legge quella riga e se ne
// tira fuori l'unica cosa che conta: quale valore, quale soglia, da che parte. Se la riga ha un'altra
// forma si ritorna `null` e la pagina mostra l'originale, che e' meglio di una frase inventata.
// Pura/testabile: `t` e' la funzione di traduzione della pagina.

const NUM = '-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?'
const CONFRONTI = {
  'greater than or equal to': 'sopraUguale',
  'greater than': 'sopra',
  'less than or equal to': 'sottoUguale',
  'less than': 'sotto',
}

// Un numero come lo scriverebbe una persona: 3.0 -> 3, 0.9995 resta com'e'.
const pulito = (v) => (Number.isFinite(Number(v)) ? String(Number(v)) : String(v))

// Cosa vuol dire quella metrica, dalla sola parola nel nome. Nessun elenco di nomi di nessuno: solo le
// parole che dicono «riuscito» o «sbagliato» in quasi ogni sistema. Qualunque altra metrica: niente
// frase, perche' una spiegazione sbagliata e' peggio di nessuna.
const SUCCESSO = /succe|complet|\bok\b/i
const ERRORE = /error|fail|fault|5xx|errori|fallit/i

export function fraseAllarme(motivo, t, { metrica = null } = {}) {
  if (typeof motivo !== 'string' || !motivo.trim()) return null
  const successo = typeof metrica === 'string' && SUCCESSO.test(metrica)
  const errore = typeof metrica === 'string' && ERRORE.test(metrica)

  // «Nessun dato» e' la forma dei job che non girano: l'allarme guarda un conteggio che non arriva.
  const vuoto = /no datapoints were received for (\d+) periods?/i.exec(motivo)
  if (vuoto) return t(successo ? 'alarm.noDataSuccesso' : 'alarm.noData', { n: Number(vuoto[1]) })

  const soglia = new RegExp(`(?:was|were) (${Object.keys(CONFRONTI).join('|')}) the threshold \\((${NUM})\\)`, 'i').exec(motivo)
  if (!soglia) return null
  const verso = CONFRONTI[soglia[1].toLowerCase()]

  // I valori misurati stanno fra parentesi quadre, dal piu' recente, ciascuno con la sua data fra tonde.
  const quadre = /\[(.*?)\]\s+(?:was|were)/i.exec(motivo)
  const valori = quadre ? quadre[1].replace(/\([^)]*\)/g, '').split(',').map((x) => x.trim()).filter((x) => Number.isFinite(Number(x))) : []
  // «In pratica»: cosa vuol dire quel numero, solo quando la metrica lo dice con certezza.
  const pratica =
    successo && (verso === 'sotto' || verso === 'sottoUguale') ? t('alarm.pratica.successoBasso') : errore && (verso === 'sopra' || verso === 'sopraUguale') ? t('alarm.pratica.errori') : ''
  if (!valori.length) return t(`alarm.soglia.${verso}Senza`, { s: pulito(soglia[2]) }) + pratica

  const fuori = /(\d+) out of the last (\d+) datapoints/i.exec(motivo)
  const quante = fuori && Number(fuori[2]) > 1 ? t('alarm.quante', { n: Number(fuori[1]), m: Number(fuori[2]) }) : ''
  return t(`alarm.soglia.${verso}`, { v: pulito(valori[0]), s: pulito(soglia[2]) }) + quante + pratica
}
