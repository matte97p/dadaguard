import { resolveServices } from './server/status.js'
import { deduceTopology } from './server/topology/deduce.js'
setTimeout(() => { console.log('ABBANDONO dopo 150s: il giro non finisce'); process.exit(1) }, 150000).unref?.()
const t0 = Date.now()
const { accounts, services } = await resolveServices()
console.log('resolveServices', Date.now() - t0, 'ms ·', services.length, 'servizi ·', Object.keys(accounts).join(' '))
const t1 = Date.now()
const timer = setInterval(() => console.log('   ...', Math.round((Date.now() - t1) / 1000), 's'), 15000)
const g = await deduceTopology(services, accounts)
clearInterval(timer)
console.log('deduceTopology', Date.now() - t1, 'ms ·', g.nodes.length, 'nodi', g.edges.length, 'archi')
process.exit(0)
