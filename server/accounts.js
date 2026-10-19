import { accessoAccount } from '../shared/accessoAws.js'

// Quando un account è INTERROGABILE, e perché non basta che sia scritto in config.
//
// Per parlare con un account servono credenziali, e possono arrivare da tre strade:
//   - `profile`   — un profilo SSO locale (solo in locale);
//   - `roleArn`   — un ruolo read-only assunto cross-account (+ `externalId`);
//   - `inAccount` — le credenziali dell'AMBIENTE, cioè l'account in cui Dadaguard stesso gira (in
//                   cloud il task role, che vive nel payer). Va dichiarato: "nessuna credenziale"
//                   e "le credenziali di qui" sono due cose diverse, e indovinare significherebbe
//                   interrogare l'account sbagliato.
// Senza nessuna delle tre, l'account è solo un'etichetta: compare nelle liste, ma non si può leggere.
export function isQueryable(a) {
  return Boolean(a?.profile || a?.roleArn || a?.inAccount)
}

// Gli account interrogabili, come coppie [chiave, account]. Puro/testabile.
export function queryableAccounts(accounts) {
  return Object.entries(accounts ?? {}).filter(([, a]) => isQueryable(a))
}

// La lista degli account per il FRONTEND: serve anche per quelli senza un solo servizio, altrimenti
// le pagine per-account (Costi, Sprechi, Quote) perdono l'account — un account può avere spesa e zero
// servizi monitorati (il payer, dove vivono Bedrock e CodeBuild; un account di sicurezza). Prima le
// etichette si ricavavano dai SERVIZI, quindi quegli account sparivano senza dirlo. Puro/testabile.
// Con `accesso` la pagina compone comandi e link sulla stessa strada del server (vedi
// shared/accessoAws.js): nomi di app, ruoli e profili, nessun segreto.
export function accountsSummary(accounts, cfg = {}) {
  return Object.entries(accounts ?? {}).map(([key, a]) => ({
    key,
    label: a?.label ?? key,
    color: a?.color ?? null,
    region: a?.region ?? null,
    queryable: isQueryable(a),
    accesso: accessoDi(a, cfg),
  }))
}

// La strada verso AWS di un account, dalla config dell'installazione. Teleport c'e' quando la
// config lo dice: `teleport.proxy`, oppure l'host di `teleport.webUrl`, che la superficie Accessi
// usa gia'. Il portale SSO da `sso.startUrl`.
export function accessoDi(acct, cfg = {}) {
  const tp = cfg?.teleport ?? null
  const proxy = tp?.proxy ?? (tp?.webUrl ? hostDi(tp.webUrl) : null)
  return accessoAccount(acct, { teleport: proxy ? { proxy, cluster: tp?.cluster ?? null } : null, sso: cfg?.sso ?? null })
}

const hostDi = (url) => {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}
