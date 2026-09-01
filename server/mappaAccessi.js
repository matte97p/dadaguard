// La MAPPA degli accessi: chi e' questa persona, e cosa puo' fare, in un posto solo.
//
// Perche' esiste: gli accessi di una persona vivono su due strade che non si parlano. Da una parte
// Teleport, dove i team GitHub decidono i ruoli con cui si arriva ai database, ai log e alle cache;
// dall'altra AWS Identity Center, dove i gruppi decidono i permission set che si vedono nel portale.
// Chi deve rispondere a «cosa vede Tizio?» oggi apre due console e mette insieme a mano due elenchi,
// ed e' il modo in cui un permesso resta addosso a chi ha cambiato mestiere.
//
// Le tre fonti, tutte in SOLA LETTURA e tutte gia' raggiungibili (nessun token nuovo):
//   1. audit del cluster Teleport (CloudWatch, account security) → persona → team GitHub. Il campo
//      `attributes` dell'evento `user.login` porta i team che il connector ha visto in quel momento.
//      La lettura e' `teleport.login()`, che interroga i SOLI eventi di login con Logs Insights: non
//      e' la stessa di `audit()` apposta, e la ragione sta nel commento di quella funzione (in breve:
//      audit si ferma a 5000 eventi e su una settimana le query si mangiano il tetto, quindi la mappa
//      usciva vuota mentre la pagina accanto mostrava nove persone).
//      ⚠️ Sa solo di chi ha fatto login DENTRO la finestra: chi manca non e' senza accessi, e' senza
//      login recenti, e la pagina lo dice invece di far sembrare vuoto un permesso che c'e'.
//   2. parametro SSM `/teleport/team-roles` (account security) → team → ruoli Teleport. Lo scrive lo
//      script che applica il connector, quindi non e' una copia che invecchia: se cambia la mappa,
//      cambia quando cambia davvero. Se il parametro manca, questa meta' resta vuota e lo dice.
//   3. Identity Center → gruppo/persona → permission set per account. E' `ssoAccess()`, la stessa
//      lettura della pagina IAM: qui viene ROVESCIATA, da «chi ha questo permission set» a «cosa ha
//      questa persona», che e' la domanda con cui si arriva.
//
// ⚠️ Le due strade hanno nomi diversi per la stessa persona (`GiuliaVerdi88` su GitHub,
// `GiuliaVerdi` in Identity Center). L'accoppiamento e' un confronto sul nome normalizzato piu'
// le eccezioni scritte in config: quando non torna, la riga resta SCOLLEGATA invece di indovinare.
// Un accoppiamento sbagliato qui direbbe che una persona ha permessi che sono di un'altra.
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm'
import { loadConfig } from './config.js'
import { resolveServices } from './status.js'
import { cached } from './util/ttlcache.js'
import { clientOpts, cleanAwsReason } from './runtime/awsClient.js'
import { conto } from './accessi.js'
import * as teleport from './teleport.js'
import { ssoAccess } from './sso.js'

const PARAM_DEFAULT = '/teleport/team-roles'

// Nome confrontabile fra le due directory: minuscolo, senza punti/trattini/underscore e senza le
// cifre in coda (`GiuliaVerdi88` → `giuliaverdi`). Le cifre in coda sono il rumore tipico dei
// login GitHub; quelle in mezzo restano, perche' li' distinguono davvero due persone.
export const normalizza = (nome) =>
  String(nome ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/\d+$/, '')

// team → ruoli, dal parametro SSM scritto da chi applica il connector.
// Legge per PATH e non per nome: `ssm:GetParametersByPath` e' il permesso che il ruolo read-only ha
// gia' (vedi modules/cross-account-readonly-role), `GetParameter` no.
async function ruoliPerTeam(aws, nomeParam) {
  const path = nomeParam.slice(0, nomeParam.lastIndexOf('/')) || '/'
  const ssm = new SSMClient(clientOpts(aws))
  let token
  do {
    const out = await ssm.send(new GetParametersByPathCommand({ Path: path, Recursive: true, WithDecryption: false, NextToken: token, MaxResults: 10 }))
    for (const p of out.Parameters ?? []) {
      if (p.Name !== nomeParam) continue
      const doc = JSON.parse(p.Value ?? '{}')
      return {
        teams: doc.teams ?? {},
        generato: doc.generato ?? null,
        cluster: doc.cluster ?? null,
        organizzazione: doc.org ?? null,
        scritto: p.LastModifiedDate ? new Date(p.LastModifiedDate).getTime() : null,
      }
    }
    token = out.NextToken
  } while (token)
  return { assente: true, teams: {} }
}

// Identity Center rovesciato: da permission set → assegnatari, a gruppo → permessi e persona →
// permessi. Un gruppo compare anche se ha zero membri: un gruppo vuoto con dei permessi attaccati e'
// una cosa da vedere, non una riga da nascondere.
function rovesciaSso(sso) {
  const gruppi = new Map()
  const persone = new Map()
  const perGruppo = (nome) => {
    if (!gruppi.has(nome)) gruppi.set(nome, { gruppo: nome, membri: undefined, permessi: [] })
    return gruppi.get(nome)
  }
  const perPersona = (nome) => {
    if (!persone.has(nome)) persone.set(nome, { utente: nome, gruppi: new Set(), permessi: [] })
    return persone.get(nome)
  }

  for (const ps of sso?.permissionSets ?? []) {
    for (const a of ps.assignments ?? []) {
      const permesso = { account: a.account, permissionSet: ps.name }
      if (a.type === 'group') {
        const g = perGruppo(a.name)
        g.permessi.push(permesso)
        // `members` undefined = non leggibili (manca il permesso), [] = gruppo davvero vuoto.
        if (a.members !== undefined) g.membri = a.members
        for (const m of a.members ?? []) {
          const p = perPersona(m)
          p.gruppi.add(a.name)
          p.permessi.push({ ...permesso, via: a.name })
        }
      } else {
        const p = perPersona(a.name)
        p.permessi.push({ ...permesso, via: null })
      }
    }
  }
  return {
    gruppi: [...gruppi.values()].sort((x, y) => x.gruppo.localeCompare(y.gruppo)),
    persone: new Map([...persone].map(([k, v]) => [k, { ...v, gruppi: [...v.gruppi].sort() }])),
  }
}

// Le eccezioni all'accoppiamento, dalla config: `teleport.persone: [{ github: gverdi23x, sso: GiuliaRossi }]`.
// Servono dove il nome normalizzato non basta, che e' la regola appena il login GitHub non e' nome e
// cognome. Chiave e valore sono normalizzati, cosi' la config non deve azzeccare le maiuscole.
function eccezioni(cfg) {
  const m = new Map()
  for (const e of cfg?.persone ?? []) {
    if (e?.github && e?.sso) m.set(normalizza(e.github), normalizza(e.sso))
  }
  return m
}

// L'INCROCIO vero e proprio, separato dalle tre letture: prende i tre pezzi gia' in mano e ne fa le
// righe della pagina. Sta qui fuori perche' e' la parte che si puo' sbagliare in silenzio (un
// accoppiamento storto dice che una persona ha i permessi di un'altra) ed e' quindi la parte che deve
// avere delle prove: `test/mappa-accessi.test.js` la chiama senza toccare AWS.
export function componiMappa({ audit = {}, ruoli = {}, sso = {}, cfg = {} } = {}) {
  const rovesciato = rovesciaSso(sso)
  const scorciatoie = eccezioni(cfg)

  // Indice delle persone di Identity Center per nome normalizzato, per agganciarle a quelle di
  // Teleport. Se due utenze normalizzano allo stesso nome l'indice tiene la prima e la seconda resta
  // scollegata: meglio una riga in piu' che due persone fuse in una.
  const ssoPerNome = new Map()
  for (const [nome, dati] of rovesciato.persone) {
    const k = normalizza(nome)
    if (!ssoPerNome.has(k)) ssoPerNome.set(k, dati)
  }

  const usate = new Set()
  const persone = (audit.persone ?? []).map((p) => {
    const k = scorciatoie.get(normalizza(p.utente)) ?? normalizza(p.utente)
    const lato = ssoPerNome.get(k)
    if (lato) usate.add(lato.utente)
    const teams = p.teams ?? []
    // I ruoli sono l'UNIONE dei ruoli dei suoi team, che e' come li somma Teleport al login.
    const ruoliPersona = [...new Set(teams.flatMap((t) => ruoli.teams?.[t] ?? []))].sort()
    return {
      persona: p.utente,
      organizzazione: p.organizzazione ?? ruoli.organizzazione ?? null,
      ultimoLogin: p.ultimoLoginOk ?? null,
      teams,
      // `null` = non lo sappiamo (nessun login nella finestra), `[]` = login visto e nessun team.
      teamsNoti: p.teams != null,
      ruoli: ruoliPersona,
      // I team che nessuna riga della mappa nomina: o il connector non li mappa (e allora quella
      // persona da quel team non prende niente), o la mappa e' vecchia. In entrambi i casi va detto.
      teamsSenzaRuoli: teams.filter((t) => !(ruoli.teams?.[t]?.length)),
      ssoUtente: lato?.utente ?? null,
      gruppiSso: lato?.gruppi ?? [],
      permessi: lato?.permessi ?? [],
    }
  })

  // Chi esiste in Identity Center e NON ha fatto login su Teleport nella finestra: ha comunque dei
  // permessi nel portale, e lasciarlo fuori direbbe che non ha niente.
  for (const [nome, dati] of rovesciato.persone) {
    if (usate.has(nome)) continue
    persone.push({
      persona: nome,
      organizzazione: null,
      ultimoLogin: null,
      teams: [],
      teamsNoti: false,
      ruoli: [],
      teamsSenzaRuoli: [],
      ssoUtente: nome,
      gruppiSso: dati.gruppi,
      permessi: dati.permessi,
      soloSso: true,
    })
  }

  persone.sort((a, b) => (b.ruoli.length + b.permessi.length) - (a.ruoli.length + a.permessi.length) || a.persona.localeCompare(b.persona))

  // Vista per TEAM: i ruoli che porta e chi ci sta dentro (visto ai login della finestra). Comprende
  // anche i team che la mappa nomina e che nessuno ha usato: un team mappato e vuoto e' una riga che
  // interessa, perche' e' un permesso acceso che non serve a nessuno.
  const membriPerTeam = new Map()
  for (const p of persone) for (const t of p.teams) membriPerTeam.set(t, [...(membriPerTeam.get(t) ?? []), p.persona])
  const teams = [...new Set([...Object.keys(ruoli.teams ?? {}), ...membriPerTeam.keys()])].sort().map((team) => ({
    team,
    ruoli: [...(ruoli.teams?.[team] ?? [])].sort(),
    membri: (membriPerTeam.get(team) ?? []).sort(),
    // Un team senza ruoli nella mappa non concede niente su Teleport: di norma e' un team dei
    // REPOSITORY (gli accessi e i repo sono due alberi separati), e va detto invece di sembrare rotto.
    soloRepo: !(ruoli.teams?.[team]?.length),
  }))

  return { persone, teams, gruppiSso: rovesciato.gruppi }
}

// La risposta della rotta, montata a parte dalle tre letture. E' una funzione perche' il primo giro
// non lo era e si e' rotta proprio qui: il pezzo che elenca i gruppi nominava una variabile rimasta
// dentro `componiMappa` dopo un riordino, quindi la rotta rispondeva 500 e la pagina mostrava due
// tabelle vuote, che e' esattamente il modo in cui un guasto si traveste da «non c'e' niente».
// Le prove la chiamano con le tre fonti finte, comprese quelle rotte.
export function rispostaMappa({ audit, ruoli = {}, sso = {}, cfg = {}, ore = 168, nomeParam = PARAM_DEFAULT } = {}) {
  const { persone, teams, gruppiSso } = componiMappa({ audit: audit ?? {}, ruoli, sso, cfg })
  return {
    configurato: true,
    ore,
    webUrl: cfg.webUrl ?? null,
    persone,
    teams,
    gruppiSso,
    // Cosa ha risposto e cosa no: senza questo, una fonte muta si legge come «nessun accesso».
    fonti: {
      teleport: audit?.errore
        ? { errore: audit.errore }
        : audit?.incompleta
          ? { incompleta: audit.incompleta }
          : { ok: true, persone: (audit?.persone ?? []).length, troncato: Boolean(audit?.troncato) },
      ruoli: ruoli.errore
        ? { errore: ruoli.errore }
        : ruoli.assente
          ? { assente: nomeParam }
          : { ok: true, teams: Object.keys(ruoli.teams ?? {}).length, generato: ruoli.generato, scritto: ruoli.scritto },
      sso: sso?.errore ? { errore: sso.errore } : sso?.available ? { ok: true, permissionSets: (sso.permissionSets ?? []).length } : { assente: true },
    },
  }
}

export async function mappaAccessi({ ore = 168 } = {}) {
  const cfg = loadConfig().teleport
  if (!cfg) return { configurato: false }
  const finestra = Math.min(720, Math.max(1, Number(ore) || 168))
  const { accounts } = await resolveServices()

  const nomeParam = cfg.ruoliParam ?? PARAM_DEFAULT
  const contoRuoli = conto(accounts, cfg.ruoliAccount ?? cfg.audit?.account)

  const contoAudit = conto(accounts, cfg.audit?.account)

  const [audit, ruoli, sso] = await Promise.all([
    contoAudit
      ? cached(`mappa:login:${finestra}`, 600_000, () => teleport.login(contoAudit, { logGroup: cfg.audit?.logGroup, ore: finestra })).catch((err) => ({
          errore: cleanAwsReason(err),
          persone: [],
        }))
      : { errore: `account "${cfg.audit?.account ?? '?'}" non configurato in accounts`, persone: [] },
    contoRuoli
      ? cached(`mappa:ruoli:${nomeParam}`, 300_000, () => ruoliPerTeam(contoRuoli, nomeParam)).catch((err) => ({ errore: cleanAwsReason(err), teams: {} }))
      : { errore: `account "${cfg.ruoliAccount ?? cfg.audit?.account ?? '?'}" non configurato in accounts`, teams: {} },
    cached('mappa:sso', 300_000, () => ssoAccess(accounts)).catch((err) => ({ errore: cleanAwsReason(err) })),
  ])

  return rispostaMappa({ audit, ruoli, sso, cfg, ore: finestra, nomeParam })
}
