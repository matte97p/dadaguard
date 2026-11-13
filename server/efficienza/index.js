import { CostExplorerClient, GetSavingsPlansCoverageCommand } from '@aws-sdk/client-cost-explorer'
import { clientOpts, cleanAwsReason } from '../runtime/awsClient.js'
import { cached } from '../util/ttlcache.js'
import { isQueryable } from '../accounts.js'
import { prezziFargate, tariffeSpot, conSpot } from './prezzi.js'
import { postgresConfigurati, leggiUrl } from './pgStat.js'
import { calcoloAccount } from './ecs.js'
import { databaseAccount } from './rds.js'
import { costoOraTask, settimanaTipo, oreFerme, ORE_FERME_MINIME, nonProduzione, ordinaLeve, ORE_MESE } from './regole.js'

// Efficienza: quanto della capacità pagata si usa davvero, e quali leve recuperano soldi. Mette insieme
// calcolo (ECS Fargate) e database (RDS) di tutti gli account interrogabili e compone le leve.
// Tutto in sola lettura; i prezzi sono di listino (la fattura netta sta in Spesa).

const ORA = 60 * 60 * 1000
// Il tag che dice di chi è una risorsa. Di default lo stesso della spesa per componente, così le due
// pagine raggruppano allo stesso modo.
export const TAG_SQUADRA = process.env.DADAGUARD_TEAM_TAG || process.env.DADAGUARD_COMPONENT_TAG || 'Component'

// Copertura dei Savings Plan sugli ultimi 30 giorni: quanta spesa on-demand è coperta da un impegno.
// Cost Explorer si paga a chiamata: un'ora di cache. Permesso: ce:GetSavingsPlansCoverage.
function coperturaImpegni(aws) {
  return cached(`eff:sp:${aws.roleArn ?? aws.profile ?? 'self'}`, ORA, async () => {
    const fine = new Date()
    const inizio = new Date(fine.getTime() - 30 * 24 * ORA)
    const giorno = (d) => d.toISOString().slice(0, 10)
    const ce = new CostExplorerClient(clientOpts({ ...aws, region: 'us-east-1' }))
    const r = await ce.send(
      new GetSavingsPlansCoverageCommand({ TimePeriod: { Start: giorno(inizio), End: giorno(fine) }, Granularity: 'MONTHLY' }),
    )
    let coperta = 0
    let totale = 0
    for (const c of r.SavingsPlansCoverages ?? []) {
      coperta += Number(c.Coverage?.SpendCoveredBySavingsPlans ?? 0)
      totale += Number(c.Coverage?.TotalCost ?? 0)
    }
    return { quota: totale > 0 ? coperta / totale : 0, coperta, totale }
  })
}

// Le leve di un account, dai servizi e dai database già raccolti. Puro: testabile senza AWS.
export function leveAccount({ account, ambienteNonProd, servizi = [], database = [], settimana }) {
  const leve = []
  const base = (o, extra) => ({ account, squadra: o.squadra ?? null, oggetto: o.nome ?? o.id, ...extra })
  for (const s of servizi) {
    if (s.costoOraTask == null) continue
    if (s.proposta) {
      const nuovo = costoOraTask({ cpu: s.proposta.cpu, memMb: s.proposta.memMb, quotaSpot: s.quotaSpot }, s.listino)
      leve.push(
        base(s, {
          tipo: 'taglia',
          risorsa: 'ecs',
          rischio: 'basso',
          come: 'deploy',
          usdMese: (s.costoOraTask - nuovo) * s.taskMedi * ORE_MESE,
          dati: { da: { cpu: s.cpu, memMb: s.memMb }, a: { cpu: s.proposta.cpu, memMb: s.proposta.memMb }, cpuP95: s.cpuP95, memP95: s.memP95 },
        }),
      )
    }
    if (s.eccessoMinimoTaskOra > 0) {
      leve.push(
        base(s, {
          tipo: 'minimo',
          risorsa: 'ecs',
          rischio: 'basso',
          come: 'config',
          usdMese: s.eccessoMinimoTaskOra * s.costoOraTask,
          dati: { minimo: s.min },
        }),
      )
    }
    // Spot per i servizi che nessuno chiama da fuori (niente load balancer): un worker che riparte da
    // una coda regge l'interruzione, un'API no. Il rischio resta medio perché la coda va verificata.
    if (s.quotaSpot === 0 && !s.bilanciato && s.listino?.spotVcpu && s.listino?.spotGb) {
      const spot = costoOraTask({ cpu: s.cpu, memMb: s.memMb, quotaSpot: 1 }, s.listino)
      leve.push(
        base(s, {
          tipo: 'spot',
          risorsa: 'ecs',
          rischio: 'medio',
          come: 'config',
          usdMese: (s.costoOraTask - spot) * s.taskMedi * ORE_MESE,
          dati: {},
        }),
      )
    }
  }
  if (ambienteNonProd && settimana) {
    const { ore } = oreFerme(settimana)
    const spegnibili = servizi.filter((s) => !s.pianificato && s.costoOraTask != null)
    if (ore >= ORE_FERME_MINIME && spegnibili.length) {
      const allOra = spegnibili.reduce((a, s) => a + s.costoOraTask * s.taskMedi, 0)
      // Lo spegnimento riguarda tutto l'ambiente, ma il risparmio si divide per squadra: chi filtra
      // per una squadra vede solo la sua parte.
      const perSquadra = {}
      for (const s of spegnibili) {
        const k = s.squadra ?? ''
        perSquadra[k] = (perSquadra[k] ?? 0) + (s.costoOraTask * s.taskMedi * ore * ORE_MESE) / 168
      }
      leve.push({
        account,
        squadra: null,
        oggetto: account,
        tipo: 'orari',
        risorsa: 'ecs',
        rischio: 'basso',
        come: 'schedule',
        usdMese: (allOra * ore * ORE_MESE) / 168,
        dati: { oreFerme: ore, servizi: spegnibili.length, perSquadra },
      })
    }
  }
  for (const d of database) {
    if (!d.proposta) continue
    leve.push(
      base(d, {
        tipo: 'rds-taglia',
        risorsa: 'rds',
        rischio: 'medio',
        come: 'riavvio',
        usdMese: d.proposta.risparmio,
        dati: { da: d.classe, a: d.proposta.classe, cpuP95: d.cpuP95, memLiberaMin: d.memLiberaMin },
      }),
    )
  }
  // Dentro il database (solo con le statistiche di Postgres): lo spazio pagato per niente. Il valore
  // è il disco al prezzo di listino del suo tipo; senza prezzo la leva non ha un importo e non compare.
  for (const d of database) {
    const pg = d.interno
    if (!pg || pg.errore || !d.discoGbMese) continue
    const gbInutili = (pg.indiciInutili ?? []).reduce((a, i) => a + i.byte, 0) / 1024 ** 3
    if (gbInutili > 0) {
      leve.push(
        base(d, {
          tipo: 'indici',
          risorsa: 'rds',
          rischio: 'medio',
          come: 'migration',
          usdMese: gbInutili * d.discoGbMese,
          dati: { gb: gbInutili, n: pg.indiciInutili.length },
        }),
      )
    }
    const morte = (pg.tabelle ?? []).filter((x) => x.segnali?.includes('morte'))
    const gbMorti = morte.reduce((a, x) => a + (x.totale * x.morte) / Math.max(1, x.vive + x.morte), 0) / 1024 ** 3
    if (gbMorti > 0) {
      leve.push(
        base(d, {
          tipo: 'morte',
          risorsa: 'rds',
          rischio: 'basso',
          come: 'config',
          usdMese: gbMorti * d.discoGbMese,
          dati: { gb: gbMorti, n: morte.length },
        }),
      )
    }
  }
  return leve
}

// Settimana tipo di un account: le vCPU usate per ora, sommate su tutti i suoi servizi.
export function settimanaAccount(servizi) {
  const somma = new Map()
  for (const s of servizi) for (const [t, v] of s.orarie ?? []) somma.set(t, (somma.get(t) ?? 0) + v)
  return settimanaTipo([...somma.entries()])
}

export async function efficienza({ accounts, giorni = 30, t }) {
  const voci = Object.entries(accounts ?? {}).filter(([, a]) => isQueryable(a))
  const out = { giorni, tagSquadra: TAG_SQUADRA, generato: new Date().toISOString(), accounts: {}, servizi: [], database: [], settimane: {}, leve: [], impegni: {} }
  // Le statistiche interne di Postgres, se configurate: si attaccano all'istanza RDS con lo stesso id.
  out.postgres = { configurati: leggiUrl().map((v) => v.id) }
  const interni = out.postgres.configurati.length ? await postgresConfigurati() : {}
  await Promise.all(
    voci.map(async ([key, a]) => {
      const aws = { profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, region: a.region }
      const info = { label: a.label ?? key, color: a.color ?? null, region: a.region ?? null, nonProd: nonProduzione(key), avvisi: [], suEc2: 0 }
      out.accounts[key] = info
      const [listino, spot] = await Promise.all([
        prezziFargate(aws, a.region).catch((err) => {
          info.avvisi.push({ cosa: 'prezzi', perche: cleanAwsReason(err, t) })
          return null
        }),
        tariffeSpot(aws).catch(() => null),
      ])
      const prezzi = conSpot(listino, spot)
      const [calc, db, sp] = await Promise.all([
        calcoloAccount(aws, { giorni, prezzi, tagSquadra: TAG_SQUADRA }).catch((err) => {
          info.avvisi.push({ cosa: 'calcolo', perche: cleanAwsReason(err, t) })
          return { servizi: [], suEc2: 0 }
        }),
        databaseAccount(aws, { tagSquadra: TAG_SQUADRA })
          .then((righe) =>
            righe.map((d) => {
              const interno = interni[d.id] ?? null
              return interno ? { ...d, interno, connessioniLimite: interno.db?.limite ?? d.connessioniLimite } : d
            }),
          )
          .catch((err) => {
            info.avvisi.push({ cosa: 'database', perche: cleanAwsReason(err, t) })
            return []
          }),
        coperturaImpegni(aws).catch(() => null),
      ])
      info.suEc2 = calc.suEc2
      if (calc.servizi.some((s) => s.taskStimati)) info.avvisi.push({ cosa: 'containerInsights' })
      const settimana = settimanaAccount(calc.servizi)
      out.settimane[key] = settimana
      out.impegni[key] = sp
      out.leve.push(...leveAccount({ account: key, ambienteNonProd: info.nonProd, servizi: calc.servizi, database: db, settimana }))
      // Le serie orarie e il listino servono solo qui: alla pagina vanno i giornalieri.
      out.servizi.push(...calc.servizi.map(({ orarie, listino, ...s }) => ({ account: key, ...s })))
      out.database.push(...db.map((d) => ({ account: key, ...d })))
    }),
  )
  out.leve = ordinaLeve(out.leve)
  return out
}
