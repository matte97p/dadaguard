// i18n del frontend (UI statica). I summary dinamici dei servizi sono tradotti lato server
// (server/i18n.js) e arrivano già nella lingua scelta via /api/status?lang=.
// Lingua: in locale default IT; in cloud (SaaS) la lingua del browser. Scelta persistita.
// Niente context: App calcola `t = makeT(lang)` e lo passa come prop ai componenti (figli diretti).
export const LANGS = ['it', 'en']

export function browserLang() {
  const l = (typeof navigator !== 'undefined' && navigator.language) || 'en'
  return l.toLowerCase().startsWith('it') ? 'it' : 'en'
}

// Lingua effettiva: preferenza salvata > (cloud ? browser : it) > browser (prima del fetch).
export function resolveLang(saved, mode) {
  if (saved && LANGS.includes(saved)) return saved
  if (mode === 'local') return 'it'
  if (mode === 'cloud') return browserLang()
  return browserLang()
}

const STRINGS = {
  it: {
    'app.subtitle': 'il watchdog del tuo stack',
    'btn.waste': 'Sprechi',
    'btn.costs': 'Costi',
    'btn.topology': 'Topologia',
    'btn.drift': 'Drift',
    'btn.discover': 'Scopri servizi',
    'btn.refresh': 'Aggiorna',
    'btn.themeLight': 'Tema chiaro',
    'btn.themeDark': 'Tema scuro',

    'filter.allAccounts': 'Tutti gli account',
    'filter.noAccount': 'Senza account',
    'filter.allRegions': 'Tutte le region',
    'filter.allTypes': 'Tutti i tipi',
    'content.lastFetch': 'Ultimo fetch:',
    'content.noServices': 'Nessun servizio per questi filtri',
    'content.servicesCount': 'servizi',
    'content.errorPrefix': 'Errore:',

    'status.down': 'giù',
    'status.degraded': 'attenzione',
    'status.idle': 'a riposo',
    'status.disabled': 'spenti',
    'status.unknown': 'sconosciuto',
    'status.up': 'ok',

    'card.status.up': 'OK',
    'card.status.degraded': 'ATTENZIONE',
    'card.status.down': 'GIÙ',
    'card.status.idle': 'A RIPOSO',
    'card.status.disabled': 'SPENTO',
    'card.label.reachable': 'Raggiungibile',
    'card.label.version': 'Versione',
    'card.label.build': 'Build',
    'card.label.runtime': 'Esecuzione',
    'card.label.drift': 'Conforme a Terraform',
    'card.label.secret': 'Secret',
    'card.label.security': 'Sicurezza',
    'card.tip.reachable': "L'endpoint pubblico risponde alle richieste, e con che latenza.",
    'card.tip.version':
      'La versione che gira davvero è quella che ti aspetti (confronto col tag/health atteso).',
    'card.tip.build':
      'Cosa gira e da quando, letto direttamente da AWS senza dichiarare nulla: tag immagine del task ECS, versione Lambda, AMI EC2 — con il «tempo fa» dell’ultimo deploy. Se dichiari una versione attesa, segnala anche il mismatch.',
    'card.tip.security':
      'Esposizioni note correlate al servizio: regole di security group aperte a internet (0.0.0.0/0) su porte sensibili, e policy IAM del suo ruolo con wildcard ampie (Action/Resource «*»). Solo lettura.',
    'card.tip.runtime':
      'Il compute reale combacia col desiderato: i task/istanze attesi sono su e in salute, gli errori bassi. «p95 805ms» = il 95% delle chiamate finisce entro 805ms (la coda lenta, non la media). Un «HTTP 200» da solo non lo dice.',
    'card.tip.drift':
      'La risorsa reale combacia con quella dichiarata in Terraform (runtime, memoria, timeout). Confronto leggero, senza «terraform plan».',
    'card.tip.secret': 'I secret che il servizio usa esistono davvero nel secret manager (Doppler/SSM).',
    'card.responds': 'risponde · HTTP {code}',
    'card.removeTitle': 'Togliere dalla watchlist?',
    'card.removeDesc': 'Smette solo di monitorarlo — non tocca AWS.',
    'card.removeOk': 'Togli',
    'card.removeCancel': 'Annulla',

    'type.lambda': 'Lambda',
    'type.rds': 'Database',
    'type.ecs': 'ECS',
    'type.asg': 'Auto Scaling',
    'type.alb': 'Load Balancer',
    'type.ec2': 'EC2',

    'costs.title': 'Costi · mese corrente',
    'costs.desc':
      'Spesa reale MTD: consumo per servizio meno crediti/rimborsi = netto (quanto paghi). Dati con ~24h di ritardo, on-demand. Diverso da «Sprechi», che è la stima a listino.',
    'costs.net': 'netto',
    'costs.usage': 'consumo {v}',
    'costs.credits': 'crediti {v}',
    'costs.creditsRefunds': 'Crediti e rimborsi',
    'costs.creditMark': '(credito)',
    'costs.none': 'Nessun costo registrato',
    'costs.noAccounts': 'Nessun account configurato',

    'waste.title': 'Risorse fisse & sprechi · a listino',
    'waste.desc':
      'Stima a listino (prezzo pieno): ~${total}/mese. Non è la bolletta — la spesa reale è in «Costi». Ogni voce dice perché è (o potrebbe essere) uno spreco.',
    'waste.level.waste': 'spreco',
    'waste.level.check': 'da verificare',
    'waste.empty': 'nessuno spreco rilevato 🎉',
    'waste.eip.title': '{n} Elastic IP non associati · ~${cost}/mese',
    'waste.eip.reason':
      'Allocati ma non collegati a nessuna risorsa: AWS li fattura proprio perché inutilizzati. Rilasciali se non servono.',
    'waste.nat.title': '{n} NAT Gateway · ~${cost}/mese',
    'waste.nat.reason':
      'Costo fisso, non uno spreco di per sé: serve quando una subnet privata deve uscire su internet. È spreco solo se nella sua VPC non c’è più nulla che lo usa.',
    'waste.ebs.title': '{n} volumi EBS staccati · {gb} GB',
    'waste.ebs.reason':
      'In stato “available”: non attaccati a nessuna istanza, quindi paghi lo storage a vuoto. Fai uno snapshot ed eliminali se non servono.',

    'topo.title': 'Topologia',
    'topo.tab.deps': 'Dipendenze',
    'topo.tab.net': 'Rete',
    'topo.desc':
      'Relazioni dedotte da AWS (env Lambda, event source, security group) — niente da dichiarare a mano. Le frecce sono «dipende da»; il colore dice come l’abbiamo capita. Se una dipendenza è giù l’arco diventa rosso.',
    'topo.legend.declared': 'dichiarata',
    'topo.legend.env': 'config / env',
    'topo.legend.event': 'event source (coda/stream)',
    'topo.legend.net': 'rete (security group)',
    'topo.legend.down': 'dipendenza giù',
    'topo.loading': 'Deduco le dipendenze da AWS…',
    'topo.noServices': 'Nessun servizio',
    'topo.noRelations':
      'Nessuna relazione rilevata: nessuna env/event-source/regola di rete collega questi servizi tra loro. (Gli archi “rete” ed “event source” richiedono i permessi ec2:DescribeSecurityGroups e lambda:ListEventSourceMappings sul ruolo read-only.)',
    'topo.netPlaceholder':
      'Mappa di rete — in arrivo (dallo state Terraform: VPC → subnet → risorsa, NAT/IGW)',

    'drift.title': 'Drift completo · terragrunt plan',
    'drift.desc':
      'Esegue terragrunt plan sul layer scelto (lento: init + provider + refresh; mette un lock sul backend). Read-only sull’infra.',
    'drift.account': 'Account',
    'drift.layer': 'Layer',
    'drift.noLayer': 'nessun layer (repoDir non configurato?)',
    'drift.run': 'Esegui plan',
    'drift.running': 'In corso… può richiedere qualche minuto (la prima volta scarica i provider).',
    'drift.failed': 'Plan fallito (exit {code})',
    'drift.drift': '⚠ DRIFT: la realtà differisce dallo state Terraform',
    'drift.nochanges': '✓ No changes: infra allineata allo state',
    'drift.nooutput': '(nessun output)',

    'discover.title': 'Scopri servizi',
    'discover.add': 'Aggiungi',
    'discover.account': 'Account',
    'discover.hideCron': 'Nascondi cron / scale / housekeeper',
    'discover.scan': 'Scansiona',
    'discover.resources': '{n} risorse',
    'discover.active': ' · attive {kept}/{total}',
    'discover.unmanaged': ' · {n} non in TF',
    'discover.all': 'tutti',
    'discover.empty': 'Niente trovato',
    'discover.already': '(già)',
    'discover.notInTf': '⚠ non in TF',
    'discover.added': '{n} aggiunti alla watchlist',
  },
  en: {
    'app.subtitle': "your stack's watchdog",
    'btn.waste': 'Waste',
    'btn.costs': 'Costs',
    'btn.topology': 'Topology',
    'btn.drift': 'Drift',
    'btn.discover': 'Discover services',
    'btn.refresh': 'Refresh',
    'btn.themeLight': 'Light theme',
    'btn.themeDark': 'Dark theme',

    'filter.allAccounts': 'All accounts',
    'filter.noAccount': 'No account',
    'filter.allRegions': 'All regions',
    'filter.allTypes': 'All types',
    'content.lastFetch': 'Last fetch:',
    'content.noServices': 'No service matches these filters',
    'content.servicesCount': 'services',
    'content.errorPrefix': 'Error:',

    'status.down': 'down',
    'status.degraded': 'degraded',
    'status.idle': 'idle',
    'status.disabled': 'disabled',
    'status.unknown': 'unknown',
    'status.up': 'ok',

    'card.status.up': 'OK',
    'card.status.degraded': 'WARNING',
    'card.status.down': 'DOWN',
    'card.status.idle': 'IDLE',
    'card.status.disabled': 'DISABLED',
    'card.label.reachable': 'Reachable',
    'card.label.version': 'Version',
    'card.label.build': 'Build',
    'card.label.runtime': 'Runtime',
    'card.label.drift': 'Terraform sync',
    'card.label.secret': 'Secrets',
    'card.label.security': 'Security',
    'card.tip.reachable': 'The public endpoint answers requests, and with what latency.',
    'card.tip.version':
      'The version actually running is the one you expect (compared to the expected tag/health).',
    'card.tip.build':
      'What runs and since when, read straight from AWS with nothing to declare: ECS task image tag, Lambda version, EC2 AMI — with the «time ago» of the last deploy. If you declare an expected version, it also flags a mismatch.',
    'card.tip.security':
      "Known exposures correlated to the service: security-group rules open to the internet (0.0.0.0/0) on sensitive ports, and the role's IAM policies with broad wildcards (Action/Resource «*»). Read-only.",
    'card.tip.runtime':
      'Real compute matches desired: expected tasks/instances are up and healthy, errors low. «p95 805ms» = 95% of calls finish within 805ms (the slow tail, not the average). An «HTTP 200» alone won’t tell you.',
    'card.tip.drift':
      'The real resource matches what’s declared in Terraform (runtime, memory, timeout). Light check, no «terraform plan».',
    'card.tip.secret': 'The secrets the service uses actually exist in the secret manager (Doppler/SSM).',
    'card.responds': 'responds · HTTP {code}',
    'card.removeTitle': 'Remove from watchlist?',
    'card.removeDesc': "Just stops monitoring it — doesn't touch AWS.",
    'card.removeOk': 'Remove',
    'card.removeCancel': 'Cancel',

    'type.lambda': 'Lambda',
    'type.rds': 'Database',
    'type.ecs': 'ECS',
    'type.asg': 'Auto Scaling',
    'type.alb': 'Load Balancer',
    'type.ec2': 'EC2',

    'costs.title': 'Costs · current month',
    'costs.desc':
      'Real spend MTD: usage per service minus credits/refunds = net (what you pay). Data ~24h delayed, on-demand. Different from «Waste», which is the list-price estimate.',
    'costs.net': 'net',
    'costs.usage': 'usage {v}',
    'costs.credits': 'credits {v}',
    'costs.creditsRefunds': 'Credits & refunds',
    'costs.creditMark': '(credit)',
    'costs.none': 'No cost recorded',
    'costs.noAccounts': 'No account configured',

    'waste.title': 'Fixed resources & waste · list price',
    'waste.desc':
      'List-price estimate (full price): ~${total}/mo. Not your bill — real spend is under «Costs». Each item says why it is (or might be) waste.',
    'waste.level.waste': 'waste',
    'waste.level.check': 'to check',
    'waste.empty': 'no waste detected 🎉',
    'waste.eip.title': '{n} unattached Elastic IPs · ~${cost}/mo',
    'waste.eip.reason':
      "Allocated but attached to nothing: AWS bills them precisely because they're idle. Release them if unused.",
    'waste.nat.title': '{n} NAT Gateways · ~${cost}/mo',
    'waste.nat.reason':
      'Fixed cost, not waste per se: needed when a private subnet must reach the internet. Only waste if nothing in its VPC uses it anymore.',
    'waste.ebs.title': '{n} detached EBS volumes · {gb} GB',
    'waste.ebs.reason':
      'In "available" state: not attached to any instance, so you pay for idle storage. Snapshot and delete them if unused.',

    'topo.title': 'Topology',
    'topo.tab.deps': 'Dependencies',
    'topo.tab.net': 'Network',
    'topo.desc':
      'Relations inferred from AWS (Lambda env, event sources, security groups) — nothing to declare by hand. Arrows mean «depends on»; the color says how we inferred it. If a dependency is down the edge turns red.',
    'topo.legend.declared': 'declared',
    'topo.legend.env': 'config / env',
    'topo.legend.event': 'event source (queue/stream)',
    'topo.legend.net': 'network (security group)',
    'topo.legend.down': 'dependency down',
    'topo.loading': 'Inferring dependencies from AWS…',
    'topo.noServices': 'No service',
    'topo.noRelations':
      'No relation detected: no env/event-source/network rule connects these services. («Network» and «event source» edges require the ec2:DescribeSecurityGroups and lambda:ListEventSourceMappings permissions on the read-only role.)',
    'topo.netPlaceholder':
      'Network map — coming soon (from Terraform state: VPC → subnet → resource, NAT/IGW)',

    'drift.title': 'Full drift · terragrunt plan',
    'drift.desc':
      'Runs terragrunt plan on the chosen layer (slow: init + providers + refresh; locks the backend). Read-only on the infra.',
    'drift.account': 'Account',
    'drift.layer': 'Layer',
    'drift.noLayer': 'no layer (repoDir not configured?)',
    'drift.run': 'Run plan',
    'drift.running': 'Running… may take a few minutes (first run downloads the providers).',
    'drift.failed': 'Plan failed (exit {code})',
    'drift.drift': '⚠ DRIFT: reality differs from the Terraform state',
    'drift.nochanges': '✓ No changes: infra matches the state',
    'drift.nooutput': '(no output)',

    'discover.title': 'Discover services',
    'discover.add': 'Add',
    'discover.account': 'Account',
    'discover.hideCron': 'Hide cron / scale / housekeeper',
    'discover.scan': 'Scan',
    'discover.resources': '{n} resources',
    'discover.active': ' · active {kept}/{total}',
    'discover.unmanaged': ' · {n} not in TF',
    'discover.all': 'all',
    'discover.empty': 'Nothing found',
    'discover.already': '(already)',
    'discover.notInTf': '⚠ not in TF',
    'discover.added': '{n} added to the watchlist',
  },
}

function interpolate(s, vars) {
  if (!vars) return s
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
  return s
}

// Ritorna t(key, vars): cerca la chiave nella lingua scelta, fallback IT, poi la chiave stessa.
export function makeT(lang) {
  const L = STRINGS[lang] ? lang : 'it'
  return (key, vars) => interpolate(STRINGS[L][key] ?? STRINGS.it[key] ?? key, vars)
}
