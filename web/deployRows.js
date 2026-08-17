// Come si RAGGRUPPANO le righe della pagina Deploy. Sta in un modulo a parte, e non dentro la pagina,
// per una ragione pratica: qui i test girano con `node --test`, che non carica JSX, quindi la logica
// che decide cosa si vede accanto a cosa, dentro il .jsx, non poteva essere provata da nessuno. Ed è
// logica di prodotto: un'apertura di porta non è un rilascio, un riavvio non conta nel tasso di
// successo, e chi sta uscendo adesso va in cima.
import { FAILED_STATUSES, isManualRestart } from './deployKinds.js'

// Le righe che NON parlano di un servizio: aprire o richiudere una porta riguarda un security group, e
// il suo id (`sg-0046fdc5fa3522a28`) finiva nella colonna del servizio. Effetto doppio: sette gruppi
// chiamati con un id in mezzo ai servizi veri, e sette id nella tendina «Servizio» come se ci si
// potesse filtrare sopra. Vanno tutte in un gruppo solo, che dice cosa sono.
const SENZA_SERVIZIO = new Set(['sg-open', 'sg-close'])
export const isServiceRow = (b) => !SENZA_SERVIZIO.has(b?.kind)
export const GRUPPO_SG = '\u0000sg' // chiave che nessun servizio AWS può avere: l'etichetta la mette la UI

// Raggruppa le build per servizio, dal più recente. Per ogni servizio calcola l'ultima build,
// i conteggi ok/fallito e la lista (per il trend). In-corso prima, poi ordine alfabetico.
export function groupByService(builds) {
  const map = new Map()
  for (const b of builds) {
    const svc = isServiceRow(b) ? b.service || b.project || '—' : GRUPPO_SG
    if (!map.has(svc)) map.set(svc, [])
    map.get(svc).push(b)
  }
  const groups = []
  for (const [service, arr] of map) {
    const sorted = [...arr].sort((a, b) => new Date(b.startedAt ?? 0) - new Date(a.startedAt ?? 0))
    // Tasso di successo e trend contano solo le BUILD: un riavvio riuscito non dice niente
    // sull'affidabilità dei rilasci, e mescolarlo gonfierebbe il rapporto proprio quando un
    // servizio va male (ogni riavvio per rimetterlo in piedi lo farebbe sembrare più sano).
    const onlyBuilds = sorted.filter((x) => !isManualRestart(x))
    groups.push({
      service,
      sgGroup: service === GRUPPO_SG,
      builds: sorted,
      trend: onlyBuilds,
      latest: sorted[0],
      ok: onlyBuilds.filter((x) => x.status === 'SUCCEEDED').length,
      failed: onlyBuilds.filter((x) => FAILED_STATUSES.includes(x.status)).length,
    })
  }
  return groups.sort((a, b) => {
    // Le porte aperte a mano stanno in fondo: sono importanti, ma non sono un rilascio, e in mezzo ai
    // servizi rubano il posto in cima a chi sta uscendo adesso.
    if (a.sgGroup !== b.sgGroup) return a.sgGroup ? 1 : -1
    const ai = a.latest.inProgress ? 0 : 1
    const bi = b.latest.inProgress ? 0 : 1
    if (ai !== bi) return ai - bi
    return a.service.localeCompare(b.service)
  })
}
