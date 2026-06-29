// Dizionario lato server per i SUMMARY dinamici dei check (quelli costruiti con valori
// interpolati, es. "3 chiamate · 0% errori"). La UI statica è tradotta lato FE (web/i18n.jsx).
// Il FE passa la lingua via /api/status?lang=it|en; qui `makeT(lang)` ritorna un t(key, vars).
// I `reason` che sono errori AWS grezzi NON si traducono (restano il messaggio originale).
const S = {
  it: {
    'version.mismatch': 'gira {actual}, atteso {expected}',
    'version.nosource': 'nessuna fonte versione (manca healthUrl)',
    'version.fieldmissing': "campo '{field}' assente nel payload",
    'version.timeout': 'timeout',
    'version.notjson': 'health non leggibile come JSON',
    'liveness.timeout': 'timeout >{ms}ms',

    'lambda.cron.disabled': 'cron disattivata di proposito (ogni {sched})',
    'lambda.cron.down': '⚠ nessuna esecuzione in {window} (attesa ogni {sched})',
    'lambda.runs': '{n} esecuzioni',
    'lambda.errors': '{n} errori',
    'lambda.throttled': '{n} limitate da AWS',
    'lambda.idle': 'nessuna chiamata in {window} · in attesa',
    'lambda.calls': '{n} chiamate',
    'lambda.errpct': '{p}% errori',
    'lambda.p95': 'p95 {ms}ms',
    'lambda.neartimeout': 'vicina al timeout ({s}s)',
    'lambda.aliasnotfound': "alias '{alias}' non trovato ({name})",

    'ecs.tasks': '{running}/{desired} task attivi',
    'ecs.pending': ' · {n} in avvio',
    'ecs.notfound': 'servizio ECS non trovato',

    'asg.healthy': '{healthy}/{desired} istanze sane',
    'asg.notfound': 'Auto Scaling Group non trovato',

    'rds.cluster': '{engine} · {status} · {available}/{total} istanze',
    'rds.instance': '{engine} · {status}',
    'rds.clusternotfound': 'cluster RDS non trovato',
    'rds.instancenotfound': 'istanza RDS non trovata',
    'rds.missing': 'manca `cluster` o `instance`',
    'rds.status.available': 'disponibile',
    'rds.status.creating': 'in creazione',
    'rds.status.modifying': 'in modifica',
    'rds.status.backing-up': 'backup in corso',
    'rds.status.starting': 'in avvio',
    'rds.status.stopped': 'ferma',
    'rds.status.failed': 'in errore',

    'alb.targets': '{healthy}/{total} target sani',
    'alb.notarget': 'nessun target collegato',
    'alb.state': 'stato {code}',
    'alb.notfound': 'load balancer non trovato',
    'alb.healthUnreachable': 'attivo · health dei target non raggiungibile',

    'ec2.checks': 'in funzione · check AWS {ok}/2 ok',
    'ec2.notfound': 'istanza EC2 non trovata',
    'ec2.state.running': 'in funzione',
    'ec2.state.stopped': 'ferma',
    'ec2.state.terminated': 'terminata',
    'ec2.state.pending': 'in avvio',
    'ec2.state.stopping': 'in arresto',

    'drift.insync': 'combacia con Terraform',
    'drift.diverge': 'diverge da Terraform: {diffs}',
    'drift.runtime': 'runtime {actual} (TF: {expected})',
    'drift.memory': 'memoria {actual}MB (TF: {expected}MB)',
    'drift.timeout': 'timeout {actual}s (TF: {expected}s)',
    'drift.handler': 'handler diverso da Terraform',
    'drift.stateunreadable': 'state TF non leggibile',

    'runtime.unsupported': "runtime '{type}' non ancora supportato",

    'secrets.present': '{n} secret presenti',
    'secrets.none': 'nessun secret trovato in {path}',
    'secrets.missing': '{n} secret mancanti rispetto a {env}: {list}',
    'secrets.dopplernotfound': 'config Doppler non trovato o accesso negato',
    'secrets.dopplerunavailable': 'CLI Doppler non disponibile',
  },
  en: {
    'version.mismatch': 'running {actual}, expected {expected}',
    'version.nosource': 'no version source (healthUrl missing)',
    'version.fieldmissing': "field '{field}' missing in payload",
    'version.timeout': 'timeout',
    'version.notjson': 'health not readable as JSON',
    'liveness.timeout': 'timeout >{ms}ms',

    'lambda.cron.disabled': 'cron disabled on purpose (every {sched})',
    'lambda.cron.down': '⚠ no run in {window} (expected every {sched})',
    'lambda.runs': '{n} runs',
    'lambda.errors': '{n} errors',
    'lambda.throttled': '{n} throttled by AWS',
    'lambda.idle': 'no call in {window} · idle',
    'lambda.calls': '{n} calls',
    'lambda.errpct': '{p}% errors',
    'lambda.p95': 'p95 {ms}ms',
    'lambda.neartimeout': 'near timeout ({s}s)',
    'lambda.aliasnotfound': "alias '{alias}' not found ({name})",

    'ecs.tasks': '{running}/{desired} tasks running',
    'ecs.pending': ' · {n} starting',
    'ecs.notfound': 'ECS service not found',

    'asg.healthy': '{healthy}/{desired} healthy instances',
    'asg.notfound': 'Auto Scaling Group not found',

    'rds.cluster': '{engine} · {status} · {available}/{total} instances',
    'rds.instance': '{engine} · {status}',
    'rds.clusternotfound': 'RDS cluster not found',
    'rds.instancenotfound': 'RDS instance not found',
    'rds.missing': 'missing `cluster` or `instance`',
    'rds.status.available': 'available',
    'rds.status.creating': 'creating',
    'rds.status.modifying': 'modifying',
    'rds.status.backing-up': 'backing up',
    'rds.status.starting': 'starting',
    'rds.status.stopped': 'stopped',
    'rds.status.failed': 'failed',

    'alb.targets': '{healthy}/{total} healthy targets',
    'alb.notarget': 'no target attached',
    'alb.state': 'state {code}',
    'alb.notfound': 'load balancer not found',
    'alb.healthUnreachable': 'active · target health unreachable',

    'ec2.checks': 'running · AWS checks {ok}/2 ok',
    'ec2.notfound': 'EC2 instance not found',
    'ec2.state.running': 'running',
    'ec2.state.stopped': 'stopped',
    'ec2.state.terminated': 'terminated',
    'ec2.state.pending': 'starting',
    'ec2.state.stopping': 'stopping',

    'drift.insync': 'matches Terraform',
    'drift.diverge': 'diverges from Terraform: {diffs}',
    'drift.runtime': 'runtime {actual} (TF: {expected})',
    'drift.memory': 'memory {actual}MB (TF: {expected}MB)',
    'drift.timeout': 'timeout {actual}s (TF: {expected}s)',
    'drift.handler': 'handler differs from Terraform',
    'drift.stateunreadable': 'TF state not readable',

    'runtime.unsupported': "runtime '{type}' not supported yet",

    'secrets.present': '{n} secrets present',
    'secrets.none': 'no secret found in {path}',
    'secrets.missing': '{n} secrets missing vs {env}: {list}',
    'secrets.dopplernotfound': 'Doppler config not found or access denied',
    'secrets.dopplerunavailable': 'Doppler CLI not available',
  },
}

// Ritorna t(key, vars): interpola {var} nel template della lingua scelta (fallback IT).
export function makeT(lang) {
  const L = S[lang] ? lang : 'it'
  return (key, vars) => {
    let s = S[L][key] ?? S.it[key] ?? key
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
    return s
  }
}

// t neutro (identità) per quando un check gira senza lingua (es. fuori da una richiesta HTTP).
export const identityT = (key, vars) => {
  let s = key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
  return s
}
