// I token d'AMBIENTE nei nomi delle risorse AWS.
//
// Perché esiste questo file: mezzo repo doveva togliere il prefisso dell'organizzazione dai nomi
// (`<org>-<env>-<servizio>` → `<servizio>`), e lo faceva scrivendo quel nome nel codice. In un repo
// pubblico è una firma: dice di chi è l'infrastruttura che lo strumento sta guardando. E per chiunque
// altro lo usi era anche sbagliato — la sua organizzazione si chiama in un altro modo.
//
// L'ancora giusta non è il nome dell'organizzazione, è l'AMBIENTE: quello sì che si ripete uguale
// dappertutto. Si toglie il primo segmento solo quando è seguito da un ambiente riconoscibile, così
// `acme-production-backend` → `backend` e `payments-worker` resta intero.
export const ENV_TOKENS = ['production', 'prod', 'prd', 'staging', 'stg', 'stage', 'management', 'mgmt', 'security', 'dev', 'test']

const ENV_ALT = ENV_TOKENS.join('|')

// `<org>-<env>-` in testa a un nome (o `<env>-` da solo). Il primo segmento cade SOLO se dopo c'è un
// ambiente: senza quella condizione, un nome come `payments-worker` perderebbe `payments`. Pura.
export const ORG_ENV_PREFIX = new RegExp(`^(?:[a-z0-9]+-)?(?:${ENV_ALT})-`, 'i')

// Solo l'ambiente in testa, senza organizzazione davanti. Pura.
export const ENV_PREFIX = new RegExp(`^(?:${ENV_ALT})-`, 'i')

// Toglie `<org>-<env>-` (o `<env>-`) dalla testa. Se non c'è, il nome torna intero. Pura/testabile.
export function stripOrgEnv(name = '') {
  return String(name).replace(ORG_ENV_PREFIX, '')
}
