// Metadati che la UI mostra accanto a ogni servizio e che i check non producono da soli: il livello
// del semaforo in quattro parole, a chi tocca, il comando con cui si comincia a guardare. Tutto
// DEDOTTO da quello che il giro di stato ha gia' in mano (chiave del check, tipo di risorsa, i suoi
// identificativi): nessuna mappa per nome di risorsa, nessuna chiamata in piu'. Puro/testabile.

// Il vocabolario della UI nuova e' piu' corto di quello dei check: quattro livelli, perche' a chi
// guarda la home serve «rotto, da guardare, a posto, spento», non sei sfumature.
// `unknown` va su warn e non su ok: «non ho potuto guardare» non e' una buona notizia, e un verde
// su un servizio che non si e' riusciti a leggere e' il modo in cui un guasto passa inosservato.
const LIVELLO = { down: 'crit', degraded: 'warn', unknown: 'warn', up: 'ok', idle: 'off', disabled: 'off' }
export function livelloDi(status) {
  return LIVELLO[status] ?? 'warn'
}

// A chi tocca, per CHECK e non per servizio: lo stesso servizio puo' essere rosso per un deploy
// sbagliato (lo sistema chi l'ha scritto) o per un certificato scaduto (lo sistema chi tiene l'infra).
// Il criterio: chi possiede la LEVA che risolve. Drift, sicurezza, backup, quote e certificati si
// correggono da Terraform o dalla console, cioe' da DevOps; il codice che gira, i suoi segreti, la
// versione rilasciata e la risposta HTTP si correggono con un commit, cioe' da chi sviluppa.
const OWNER_CHECK = { drift: 'ops', security: 'ops', backups: 'ops', quotas: 'ops', runtime: 'dev', secrets: 'dev', version: 'dev', liveness: 'dev', alarms: 'dev' }
// Il runtime di una risorsa d'infrastruttura (un certificato, un database, una cache) non e' codice
// applicativo: se e' giu' la leva sta nella configurazione, non in un commit.
const TIPI_INFRA = new Set(['acm', 'rds', 'elasticache', 'opensearch', 'ec2', 'asg', 'eks', 'dynamodb', 'kinesis', 's3', 'cloudfront', 'alb'])
export function ownerDi(checkKey, tipo = null) {
  if (checkKey === 'runtime' && TIPI_INFRA.has(tipo)) return 'ops'
  return OWNER_CHECK[checkKey] ?? 'dev'
}

// Il dettaglio separato dal riassunto: `summary` resta la riga della card, `dettaglio` raccoglie
// quello che il check sapeva in piu' (il motivo, l'avviso per la chat, lo stato HTTP). `null` quando
// non c'e' niente da aggiungere, cosi' la UI non mostra un riquadro vuoto.
export function dettaglioDi(check = {}) {
  const parti = []
  if (check.reason && check.reason !== check.summary) parti.push(check.reason)
  if (check.alert && check.alert !== check.summary) parti.push(check.alert)
  if (check.httpStatus != null) parti.push(`HTTP ${check.httpStatus}`)
  if (check.latencyMs != null) parti.push(`${check.latencyMs} ms`)
  return parti.length ? parti.join(' · ') : null
}

// Apici singoli per la shell: un nome con uno spazio o un `;` resta un argomento, non diventa un
// secondo comando quando qualcuno incolla la riga.
const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`
const conAccount = (cmd, { profile, region } = {}) =>
  [cmd, region ? `--region ${q(region)}` : null, profile ? `--profile ${q(profile)}` : null].filter(Boolean).join(' ')

// Il comando suggerito, per TIPO di problema (check + tipo di risorsa), mai per nome di risorsa:
// gli argomenti arrivano dagli identificativi che la discovery ha gia' letto. Solo comandi di
// lettura o diagnosi (log, describe, plan): niente che cambi l'infrastruttura, perche' una riga
// copiata in fretta durante un guasto e' esattamente quella che non si rilegge. Dove un comando
// sicuro non si sa comporre si torna `null`: meglio nessun comando che uno inventato.
const COMANDI = {
  'runtime:lambda': (a, x) => a.function && conAccount(`aws logs tail ${q(`/aws/lambda/${a.function}`)} --since 1h --filter-pattern ERROR`, x),
  'alarms:lambda': (a, x) => a.function && conAccount(`aws logs tail ${q(`/aws/lambda/${a.function}`)} --since 1h --filter-pattern ERROR`, x),
  'runtime:ecs': (a, x) => a.cluster && a.service && conAccount(`aws ecs describe-services --cluster ${q(a.cluster)} --services ${q(a.service)} --query 'services[0].events[:5]'`, x),
  'liveness:ecs': (a, x) => a.cluster && a.service && conAccount(`aws ecs describe-services --cluster ${q(a.cluster)} --services ${q(a.service)} --query 'services[0].events[:5]'`, x),
  'alarms:*': (_a, x) => conAccount(`aws cloudwatch describe-alarms --state-value ALARM --query 'MetricAlarms[].[AlarmName,StateReason]'`, x),
  'backups:rds': (a, x) =>
    a.cluster
      ? conAccount(`aws rds describe-db-cluster-snapshots --db-cluster-identifier ${q(a.cluster)} --query 'DBClusterSnapshots[-1].[SnapshotCreateTime,Status]'`, x)
      : a.instance && conAccount(`aws rds describe-db-snapshots --db-instance-identifier ${q(a.instance)} --query 'DBSnapshots[-1].[SnapshotCreateTime,Status]'`, x),
  'runtime:acm': (a, x) => a.arn && conAccount(`aws acm describe-certificate --certificate-arn ${q(a.arn)} --query 'Certificate.[Status,NotAfter,RenewalSummary]'`, x),
  // Solo i NOMI dei parametri, senza `--with-decryption`: il comando deve poter finire in un canale.
  'secrets:*': (_a, x) => x.ssmPath && conAccount(`aws ssm get-parameters-by-path --path ${q(x.ssmPath)} --recursive --query 'Parameters[].Name'`, x),
  // `plan` e non `apply`: dice cosa diverge senza toccare niente. Solo con la cartella del repo in
  // config, che e' l'unico modo di sapere dove lanciarlo.
  'drift:*': (_a, x) => x.repoDir && `cd ${q(x.repoDir)} && terragrunt run-all plan`,
  'version:*': (_a, x) => x.progetto && conAccount(`aws codebuild list-builds-for-project --project-name ${q(x.progetto)} --max-items 5`, x),
}
export function comandoPer(checkKey, tipo, aws = {}, extra = {}) {
  const f = COMANDI[`${checkKey}:${tipo}`] ?? COMANDI[`${checkKey}:*`]
  return (f && f(aws ?? {}, extra ?? {})) || null
}

const RANGO = { crit: 3, warn: 2, off: 1, ok: 0 }

// Arricchisce il risultato di UN servizio: livello e owner per check, livello e owner del servizio
// (quelli del check che lo rende rosso), il comando del problema principale. Non toglie niente:
// `overall` e `cause` restano per chi li legge gia'.
export function arricchisciServizio(r, { aws = {}, profile = null, region = null, ssmPath = null, repoDir = null, progetto = null } = {}) {
  const tipo = r.type ?? aws?.type ?? null
  const extra = { profile, region: region ?? r.region ?? null, ssmPath, repoDir, progetto }
  const checks = Object.fromEntries(
    Object.entries(r.checks ?? {}).map(([k, c]) => {
      const livello = livelloDi(c.status)
      const problema = livello === 'crit' || livello === 'warn'
      return [
        k,
        {
          ...c,
          livello,
          owner: ownerDi(k, tipo),
          dettaglio: dettaglioDi(c),
          ...(problema ? { comando: comandoPer(k, tipo, aws, extra) } : {}),
        },
      ]
    }),
  )
  const livello = livelloDi(r.overall)
  const causa = r.cause ? checks[r.cause] : null
  // Senza causa (servizio verde o spento) a chi tocca lo dice il primo check: e' comunque utile per
  // il filtro Sviluppo/DevOps, che altrimenti non saprebbe dove mettere un servizio a posto.
  const owner = causa?.owner ?? ownerDi(Object.keys(checks)[0] ?? 'runtime', tipo)
  return {
    ...r,
    checks,
    livello,
    owner,
    dettaglio: causa?.dettaglio ?? null,
    comando: causa?.comando ?? null,
  }
}

// Il peggiore fra due livelli: serve a chi aggrega (la home a semaforo).
export const peggiore = (a, b) => ((RANGO[a] ?? 0) >= (RANGO[b] ?? 0) ? a : b)
