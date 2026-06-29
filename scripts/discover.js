// discover CLI — wrapper sul modulo server/discover.js. Stampa entry services.yaml
// pronte su stdout (diagnostica su stderr). Annota le risorse non gestite da Terraform.
//   npm run discover -- --account staging
//   npm run discover -- --account staging --exclude 'cron|scale|housekeeper'
//   npm run discover -- --account staging --all
//   npm run discover -- --profile prod-ro --region us-east-1
import { discover } from '../server/discover.js'
import { loadConfig } from '../server/config.js'

function parseArgs(argv) {
  const a = { activeDays: 30 }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--account') a.account = argv[++i]
    else if (k === '--region') a.region = argv[++i]
    else if (k === '--profile') a.profile = argv[++i]
    else if (k === '--active') a.activeDays = Number(argv[++i])
    else if (k === '--exclude') a.exclude = argv[++i]
    else if (k === '--all') a.all = true
  }
  return a
}

const args = parseArgs(process.argv.slice(2))
const { accounts } = loadConfig()

const accountKey = args.account ?? (args.profile ? null : Object.keys(accounts)[0])
const acct = accountKey ? accounts[accountKey] ?? {} : {}
const profile = args.profile ?? acct.profile
const region = args.region ?? acct.region

if (!profile) {
  console.error('Nessun profilo. Usa --account <key> (definito in services.yaml) o --profile <nome>.')
  process.exit(1)
}
console.error(`# discover → account=${accountKey ?? '(diretto)'} profile=${profile} region=${region ?? '(default SDK)'}`)

const { candidates, activeInfo, tfState } = await discover({
  profile,
  region,
  stateBucket: acct.terraform?.stateBucket,
  activeDays: args.activeDays,
  exclude: args.exclude,
  all: args.all,
})

if (activeInfo) {
  console.error(`# attive (invocate < ${activeInfo.days}g): ${activeInfo.kept}/${activeInfo.total} lambda`)
}
if (tfState?.stateCount != null) {
  console.error(`# terraform: ${tfState.stateCount} state file letti · ${tfState.unmanaged} risorse NON gestite`)
} else if (tfState?.error) {
  console.error(`# terraform: state non letto (${tfState.error})`)
}
console.error(`# output: ${candidates.length} risorse`)

const acctRef = accountKey ? `\n    account: ${accountKey}` : ''
const toInline = (o) => '{ ' + Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(', ') + ' }'
const blocks = candidates.map((c) => {
  const warn = c.managed === false ? '  # ⚠ non gestita da Terraform\n' : ''
  return `${warn}  - name: ${c.name}${acctRef}\n    aws: ${toInline(c.aws)}`
})
console.log(blocks.join('\n\n'))
