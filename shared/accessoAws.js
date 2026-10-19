// COME chi legge la dashboard arriva ad AWS: il comando da incollare nel terminale e il link alla
// console. Due strade, scelte dall'INSTALLAZIONE e non dalla persona:
//   · Teleport: se la config ha `teleport.proxy` e l'account la sua app (`teleportApp` +
//     `teleportRole`), il comando e' `tsh aws --app … --aws-role …` e il link passa dal launcher
//     web di Teleport (`/web/launch/…?path=`), che apre la console gia' sul ruolo giusto. Dove
//     un'installazione ha Teleport ce l'hanno tutti quelli che la guardano: a nessuno serve piu'
//     un login SSO scaduto per leggere cinque eventi di un servizio (19/10/2026).
//   · SSO: senza Teleport il comando porta `--profile <cliProfile>` e il link passa dal portale
//     (`<sso.startUrl>/#/console?…&destination=`) quando l'account dice il ruolo (`ssoRole`).
//     Senza portale resta il link diretto alla console, come prima.
//
// Vive in `shared/` perche' i comandi e i link li compone il server (card dei servizi, deploy)
// e anche la pagina (sprechi, quote, cron): con due copie le due strade divergerebbero. Nessun
// import, come shared/cron.js. Puro/testabile.

// Apici singoli per la shell: un nome con uno spazio o un `;` resta un argomento.
export const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`

const host = (proxy) => String(proxy).replace(/^https?:\/\//, '').replace(/\/.*$/, '')
const ruoloArn = (ruolo, accountId) => {
  if (!ruolo) return null
  if (String(ruolo).startsWith('arn:')) return String(ruolo)
  return accountId ? `arn:aws:iam::${accountId}:role/${ruolo}` : null
}

// Quello che serve a comandi e link di UN account, senza segreti: nomi di app, ruoli e profili.
// `null` solo senza account: un account senza niente di configurato esce in modo `sso` e
// produce i comandi e i link di sempre.
export function accessoAccount(acct, { teleport = null, sso = null } = {}) {
  if (!acct) return null
  const accountId = acct.accountId != null ? String(acct.accountId) : null
  const out = {
    modo: 'sso',
    accountId,
    region: acct.region ?? null,
    profile: acct.cliProfile ?? acct.profile ?? null,
  }
  if (sso?.startUrl && accountId && acct.ssoRole) {
    out.portale = { startUrl: String(sso.startUrl).replace(/\/+#?\/?$/, ''), accountId, ruolo: acct.ssoRole }
  }
  if (teleport?.proxy && acct.teleportApp && acct.teleportRole) {
    const proxy = host(teleport.proxy)
    out.modo = 'teleport'
    out.teleport = {
      app: acct.teleportApp,
      ruolo: acct.teleportRole,
      proxy,
      cluster: teleport.cluster || proxy,
      publicAddr: acct.teleportPublicAddr ?? `${acct.teleportApp}.${proxy}`,
      // Il launcher vuole l'ARN intero; dal solo nome serve l'account id. Senza, il comando
      // funziona lo stesso (`tsh aws` accetta il nome) e il link ripiega sul portale o sul diretto.
      arn: ruoloArn(acct.teleportRole, accountId),
    }
  }
  return out
}

// `cmd` comincia con `aws `: diventa `tsh aws --app … --aws-role …` o resta `aws … --profile`.
// La region va sempre in fondo, perche' quella del servizio vince su quella dell'account.
// Un comando che non e' `aws` (terragrunt, docker) torna com'e'.
export function comandoAws(cmd, accesso = null, { region = null } = {}) {
  if (typeof cmd !== 'string' || !cmd) return null
  if (!cmd.startsWith('aws ')) return cmd
  const reg = region ?? accesso?.region ?? null
  const coda = reg ? ` --region ${q(reg)}` : ''
  const tp = accesso?.modo === 'teleport' ? accesso.teleport : null
  if (tp) return `tsh aws --app ${q(tp.app)} --aws-role ${q(tp.ruolo)} ${cmd.slice(4)}${coda}`
  return `${cmd}${coda}${accesso?.profile ? ` --profile ${q(accesso.profile)}` : ''}`
}

// Un link alla console AWS, girato sulla strada dell'installazione. Un URL che non e' della
// console (GitHub, PostHog) torna com'e'.
export function linkAws(url, accesso = null) {
  if (typeof url !== 'string' || !url) return url ?? null
  let u
  try {
    u = new URL(url)
  } catch {
    return url
  }
  if (!/(^|\.)console\.aws\.amazon\.com$/.test(u.hostname)) return url
  const tp = accesso?.modo === 'teleport' ? accesso.teleport : null
  if (tp?.arn) {
    // Il launcher apre la console sul ruolo e poi va a `path`, che e' relativo alla console:
    // l'host regionale si perde, ma ogni pagina porta gia' la region nella query.
    const path = `${u.pathname}${u.search}${u.hash}`
    return `https://${tp.proxy}/web/launch/${tp.publicAddr}/${tp.cluster}/${tp.publicAddr}/${encodeURIComponent(tp.arn)}?path=${encodeURIComponent(path)}`
  }
  const p = accesso?.portale
  if (p) {
    return `${p.startUrl}/#/console?account_id=${encodeURIComponent(p.accountId)}&role_name=${encodeURIComponent(p.ruolo)}&destination=${encodeURIComponent(url)}`
  }
  return url
}
