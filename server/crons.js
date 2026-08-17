// Il REGISTRO dei cron: chi sono, dove girano, con che cadenza, accesi o spenti. È la spina dorsale
// della vista delle esecuzioni: prima di chiedere «com'è andata» bisogna sapere CHE COSA esiste.
//
// La lista non si dichiara: si deduce dagli schedule di EventBridge (Rules classiche + Scheduler
// moderno, vedi server/schedules.js), esattamente come fa il dead-man switch dei check. Due
// conseguenze volute:
//   · un cron che nessuno ha messo in `services.yaml` compare comunque, ed è il caso in cui la
//     vista serve di più, perché è il job che nessuno guarda;
//   · lo stato ENABLED/DISABLED e l'espressione arrivano dalla verità di AWS, non da un file che
//     qualcuno deve ricordarsi di aggiornare.
//
// Read-only, e niente chiamate nuove rispetto a quelle che la dashboard già fa.
import { discoverSchedules, scheduleExpressionToMinutes } from './schedules.js'
import { nextRun } from './util/nextrun.js'
import { familyOfTaskDef } from './runs.js'
import { queryableAccounts } from './accounts.js'
import { cleanAwsReason } from './runtime/awsClient.js'
import { cached } from './util/ttlcache.js'
import { mapLimit } from './util/pool.js'

// Gli schedule cambiano di rado (li muove un apply Terraform, non il traffico): TTL generoso, così
// aprire la pagina dieci volte non rifà dieci volte `ListSchedules` + una `GetSchedule` per cron.
const SCHED_TTL_MS = Number(process.env.DADAGUARD_CRONS_TTL_MS) || 120_000

// Nome "umano" di un cron ECS: gli schedule si chiamano come il job, spesso con un prefisso di
// ambiente. Si tiene il nome dello schedule, che è l'identità con cui il job è conosciuto. Puro.
export function cronKey(accountKey, name) {
  return `${accountKey ?? '—'}/${name}`
}

// Un cron ECS RunTask dallo schedule scoperto. Puro/testabile.
export function ecsCron(sched, accountKey, region) {
  return {
    key: cronKey(accountKey, sched.name),
    name: sched.name,
    type: 'ecs-scheduled',
    account: accountKey,
    region: region ?? null,
    cluster: sched.cluster ?? null,
    taskDefinition: sched.taskDefArn ?? null,
    family: familyOfTaskDef(sched.taskDefArn),
    scheduleExpr: sched.expr ?? null,
    scheduleMinutes: sched.minutes ?? scheduleExpressionToMinutes(sched.expr),
    scheduleTz: sched.tz ?? null,
    enabled: sched.state !== 'DISABLED',
  }
}

// Un cron Lambda dalla mappa nome→schedule. Puro/testabile.
export function lambdaCron(name, sched, accountKey, region) {
  return {
    key: cronKey(accountKey, name),
    name,
    type: 'lambda',
    account: accountKey,
    region: region ?? null,
    function: name,
    scheduleExpr: sched?.expr ?? null,
    scheduleMinutes: sched?.minutes ?? scheduleExpressionToMinutes(sched?.expr),
    scheduleTz: sched?.tz ?? null,
    enabled: sched?.state !== 'DISABLED',
  }
}

// Prossima partenza attesa, dall'espressione vera e nel suo fuso. `rate(...)` → null (senza l'istante
// in cui la regola è stata creata non si sa dove ricade il prossimo tick, e non si inventa). Pura.
export function withNextRun(cron, now = Date.now()) {
  return { ...cron, nextRunAt: cron.enabled ? nextRun(cron.scheduleExpr, now, cron.scheduleTz) : null }
}

// Tutti i cron di tutti gli account interrogabili. Ritorna { crons, problems }: `problems` sono le
// letture non riuscite (un account senza sessione SSO, un permesso mancante): vanno DETTE, altrimenti
// «zero cron in questo account» sembra una risposta invece di una lettura fallita.
export async function listCrons(accounts, { t = (k) => k } = {}) {
  const crons = []
  const problems = []
  await mapLimit(queryableAccounts(accounts), 4, async ([key, a]) => {
    const aws = { profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, region: a.region }
    try {
      const sched = await cached(`crons:${key}:${a.region ?? ''}`, SCHED_TTL_MS, () => discoverSchedules(aws))
      for (const s of sched.ecs ?? []) crons.push(ecsCron(s, key, a.region))
      for (const [name, s] of sched.lambdas ?? []) crons.push(lambdaCron(name, s, key, a.region))
    } catch (err) {
      problems.push({ account: key, error: cleanAwsReason(err, t) })
    }
  })
  const now = Date.now()
  return {
    crons: crons.map((c) => withNextRun(c, now)).sort((a, b) => a.name.localeCompare(b.name)),
    problems,
  }
}
