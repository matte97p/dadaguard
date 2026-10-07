// La FLOTTA dei dev-env: una card per Mac, con il problema detto a parole e l'azione che lo risolve.
//
// Perche' una pagina sua (07/10/2026). La salute dei Mac stava nella pagina Accessi, in una colonna di
// una tabella larga: «nessun dato» su ogni riga, «Tool mancanti: 0» quasi ovunque, il comando `tsh ssh`
// ripetuto su ogni riga, e un Mac con tre processi uccisi per memoria alto quanto uno sano. Erano due
// mestieri in una pagina (chi entra dove, e come stanno i portatili), e il secondo perdeva.
//
// Qui si COMPONE, lato server, la risposta di `/api/flotta`: per ogni macchina i problemi in ordine di
// gravita', ciascuno con la sua azione. La pagina disegna e basta, e le regole si provano senza browser
// (`test/flotta.test.js`).
//
// ⚠️ La stessa verita' del canale. I problemi che parlano anche su Slack (OOM, VM sotto l'obiettivo,
// doctor KO, opt-out, comandi sul Mac, salute muta, motore, container non sani, dev-env fermo) NON si
// ricalcolano qui: si prendono da `segnali()` di server/accessi.js, con le stesse soglie della config.
// Una pagina che dice una cosa e un canale che ne dice un'altra insegnano a non credere a nessuno dei
// due. Qui si aggiunge solo quello che il canale non dice: immagine indietro (con la regola della
// pagina, che sa anche della versione attesa), tool mancanti, avvio non riuscito, app troppo pesante.
//
// Read-only come tutto il resto: le azioni sono FRASI e comandi da copiare, mai qualcosa che si esegue.
import { loadConfig } from './config.js'
import { resolveServices } from './status.js'
import { cached } from './util/ttlcache.js'
import { cleanAwsReason } from './runtime/awsClient.js'
import * as teleport from './teleport.js'
import { conto, configSalute, leggiHeartbeat, segnali, soglieDevEnv, SOGLIE_DEV_ENV } from './accessi.js'
import {
  appPiuPesanti,
  avvioStorto,
  dataRiferimento,
  digestCorto,
  immagineRiferimento,
  ritardo,
  tuttiIndietro,
  usoDellaMacchina,
} from '../shared/devEnv.js'

// Il livello di ogni problema sulla PAGINA. Non e' quello del canale, apposta: su Slack un OOM e'
// «attenzione» perche' il messaggio deve restare sotto la soglia del rumore, mentre qui un Mac che ha
// perso il lavoro per memoria finita e' la prima card da guardare.
//   · crit: il dev-env ha perso lavoro o non parte;
//   · warn: si guasta presto, o lavora male, e si sistema con un'azione;
//   · info: una scelta da rivedere, che oggi non rompe niente (motore, opt-out).
export const LIVELLO = Object.freeze({
  oom: 'crit',
  'dev-fermo': 'crit',
  container: 'warn',
  'vm-sotto-obiettivo': 'warn',
  'immagine-indietro': 'warn',
  'doctor-ko': 'warn',
  'lavoro-sul-mac': 'warn',
  'salute-muta': 'warn',
  'tool-mancanti': 'warn',
  'app-pesante': 'warn',
  'avvio-storto': 'warn',
  guasto: 'warn',
  'motore-non-supportato': 'info',
  'opt-out-attivi': 'info',
})

const RANGO = { crit: 0, warn: 1, info: 2, ok: 3 }
// Dentro lo stesso livello, l'ordine in cui si legge: la causa prima della conseguenza (la VM piccola
// spiega l'OOM, quindi viene subito dopo), e le cose che si sistemano da sole in fondo.
const ORDINE = Object.keys(LIVELLO)
const rango = (p) => RANGO[p.livello] * 100 + ORDINE.indexOf(p.tipo)

// Il comando che da' alla VM `gb` di memoria, per il motore che c'e'. Docker Desktop si cambia dalle
// impostazioni (nessun comando), e un motore che non si sa non ha un comando da indovinare.
export function comandoMemoria(motore, gb) {
  const m = String(motore ?? '').toLowerCase()
  if (!Number.isFinite(gb) || gb <= 0) return null
  if (m === 'colima') return `colima stop && colima start --memory ${gb}`
  if (m === 'orbstack') return `orb config set memory_mib ${gb * 1024}`
  return null
}

// I comandi che dipendono da come e' fatto il dev-env di chi installa (`teleport.devEnvComandi` in
// config): aggiornarlo, lanciare il doctor, rilanciare l'agent della salute. Senza config l'azione
// resta una frase, che e' meglio di un comando inventato.
export function comandiDevEnv(cfg = {}) {
  const c = cfg?.devEnvComandi ?? {}
  const testo = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return { aggiorna: testo(c.aggiorna), doctor: testo(c.doctor), salute: testo(c.salute), dentro: testo(c.dentro) }
}

// Un nome di container che si puo' mettere in un comando senza virgolette.
const NOME_SEMPLICE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

// L'azione che risolve UN problema: una chiave (la frase la sceglie la pagina, nella sua lingua), i
// valori che la frase usa e, quando c'e', il comando da copiare.
export function azioneDi(p, ctx = {}) {
  const { motore = null, vm = {}, comandi = {}, app = null } = ctx
  const memoria = () => {
    const gb = Number.isFinite(vm.obiettivoGb) ? Math.ceil(vm.obiettivoGb) : null
    return { k: 'memoriaVm', gb, motore, comando: comandoMemoria(motore, gb) }
  }
  switch (p.tipo) {
    case 'oom':
      // La VM sotto l'obiettivo e' la causa piu' probabile e la piu' facile da togliere; senza un
      // obiettivo, l'app che pesa di piu' e' il posto da cui cominciare.
      if (ctx.vmSotto) return memoria()
      if (app) return { k: 'riavviaApp', app: app.nome, gb: app.gb, comando: null }
      return { k: 'liberaMemoria', comando: null }
    case 'vm-sotto-obiettivo':
      return memoria()
    case 'immagine-indietro':
    case 'tool-mancanti':
      return { k: 'aggiorna', comando: comandi.aggiorna ?? null }
    case 'doctor-ko':
    case 'dev-fermo':
    case 'avvio-storto':
    case 'guasto':
      return { k: 'doctor', comando: comandi.doctor ?? null }
    case 'lavoro-sul-mac':
      return { k: 'dentroContainer', comando: comandi.dentro ?? null }
    case 'salute-muta':
      return { k: 'riavviaSalute', comando: comandi.salute ?? null }
    case 'container': {
      const nomi = p.nomi ?? []
      const comando = nomi.length && nomi.every((n) => NOME_SEMPLICE.test(n)) ? `docker restart ${nomi.join(' ')}` : null
      return { k: 'riavviaContainer', comando }
    }
    case 'app-pesante':
      return { k: 'riavviaApp', app: p.app, gb: p.gb, comando: null }
    case 'motore-non-supportato':
      return { k: 'cambiaMotore', ammessi: p.ammessi ?? [], comando: null }
    case 'opt-out-attivi':
      return { k: 'togliOptOut', nomi: p.nomi ?? [], comando: null }
    default:
      return { k: 'guarda', comando: null }
  }
}

// I segnali del canale che riguardano UNA macchina, tradotti in problemi della pagina. `immagine-
// vecchia` e `versione` restano fuori: l'immagine qui la giudica `ritardo()`, che oltre alla data sa
// della versione attesa in config, e la versione che non ha nessuno e' una notizia di flotta.
function problemaDaSegnale(s) {
  switch (s.tipo) {
    case 'oom':
      return { tipo: 'oom', quante: s.quante, uccisi: s.uccisi ?? [], quando: s.quando ?? null }
    case 'dev-fermo':
      return { tipo: 'dev-fermo', classe: s.classe ?? null, dettaglio: s.dettaglio ?? null, quando: s.quando ?? null }
    case 'container':
      return { tipo: 'container', nomi: String(s.dettaglio ?? '').split(', ').filter(Boolean), giri: s.giri, quando: s.quando ?? null }
    case 'vm-sotto-obiettivo':
      return { tipo: 'vm-sotto-obiettivo', vmGb: s.vmGb, obiettivoGb: s.obiettivoGb, stimata: Boolean(s.stimata) }
    case 'doctor-ko':
      return { tipo: 'doctor-ko', quante: s.quante, falliti: s.falliti ?? [], quando: s.quando ?? null }
    case 'lavoro-sul-mac':
      return { tipo: 'lavoro-sul-mac', quante: s.quante, bloccati: s.bloccati, forzati: s.forzati }
    case 'salute-muta':
      return { tipo: 'salute-muta', oreZitta: s.oreZitta, quando: s.quando ?? null }
    case 'motore-non-supportato':
      return { tipo: 'motore-non-supportato', motore: s.motore ?? null, candidati: s.candidati ?? [], ammessi: s.ammessi ?? [] }
    case 'opt-out-attivi':
      return { tipo: 'opt-out-attivi', nomi: s.nomi ?? [] }
    case 'guasto':
      return { tipo: 'guasto', classe: s.classe, passo: s.passo ?? null, dettaglio: s.dettaglio ?? null, quando: s.quando ?? null }
    default:
      return null
  }
}

// La macchina a cui un segnale si riferisce: il `bersaglio`, tranne che per i guasti nuovi, dove il
// bersaglio e' il dev-env intero e la macchina sta a parte.
const macchinaDel = (s) => (s.tipo === 'guasto' ? s.macchina : s.bersaglio)

const num = (x) => (Number.isFinite(x) ? x : null)

// La risposta di `/api/flotta`, da heartbeat e salute gia' letti. Puro, per le prove.
//
// ⚠️ Ogni campo e' facoltativo: le macchine che non hanno ancora aggiornato il dev-env non mandano i
// campi nuovi, e un campo che manca e' «non lo so», mai zero. Una macchina senza righe di salute non
// e' sana ne' malata: ha `saluteAssente`, e la pagina lo dice in una riga sola.
export function componiFlotta({ heartbeat = {}, salute = null } = {}, { adesso = Date.now(), soglie = SOGLIE_DEV_ENV, comandi = {} } = {}) {
  const sg = { ...SOGLIE_DEV_ENV, ...soglie }
  const battito = heartbeat && !heartbeat.errore ? heartbeat : {}
  const sal = salute && !salute.errore ? salute : null
  const righe = battito.macchine ?? []

  const lati = new Map()
  for (const r of righe) {
    if (!r?.macchina) continue
    const m = lati.get(r.macchina) ?? {}
    // `lato` assente (heartbeat vecchio) si legge come host: e' il lato che manda gli avvii dal Mac.
    m[r.lato === 'container' ? 'container' : 'host'] = r
    lati.set(r.macchina, m)
  }
  const salutePer = new Map((sal?.macchine ?? []).map((m) => [m.macchina, m]))
  const nomi = new Set([...lati.keys(), ...salutePer.keys(), ...Object.keys(sal?.ultime ?? {})])

  const perMacchina = new Map()
  for (const s of segnali({ configurato: true, audit: {}, heartbeat: battito, salute: sal ?? {} }, { adesso, soglie: sg })) {
    const nome = macchinaDel(s)
    const p = nome && problemaDaSegnale(s)
    if (!p) continue
    perMacchina.set(nome, [...(perMacchina.get(nome) ?? []), p])
  }

  const riferimento = immagineRiferimento(righe, battito.attesa ?? null)
  const dataRif = dataRiferimento(righe)

  const macchine = [...nomi].map((nome) => {
    const { host = null, container = null } = lati.get(nome) ?? {}
    const sm = salutePer.get(nome) ?? null
    const problemi = [...(perMacchina.get(nome) ?? [])]
    // Un guasto nuovo e un dev-env fermo sulla stessa macchina sono la stessa notizia: resta il piu' grave.
    if (problemi.some((p) => p.tipo === 'dev-fermo')) problemi.splice(0, problemi.length, ...problemi.filter((p) => p.tipo !== 'guasto'))

    // L'immagine: il lato messo peggio. Host e container possono avere immagini diverse (il container
    // si rifa' a ogni avvio), e il ritardo che conta e' il piu' grande.
    const ritardi = [host, container].filter(Boolean).map((r) => ({ r, ...ritardo(r, riferimento, dataRif, sg.giorniIndietro) }))
    const indietro = ritardi.filter((x) => x.indietro).sort((a, b) => (b.giorni ?? 0) - (a.giorni ?? 0))[0]
    if (indietro) {
      problemi.push({ tipo: 'immagine-indietro', giorni: indietro.giorni, creata: indietro.r.creata ?? null, perVersione: riferimento.fonte === 'config' })
    }

    if ((host?.toolMancanti ?? 0) > 0) {
      problemi.push({ tipo: 'tool-mancanti', quante: host.toolMancanti, nomi: host.toolMancantiNomi ?? [] })
    }

    // L'ULTIMO avvio, di qualsiasi lato, finito non `ok`. Se la macchina e' gia' «ferma» (due avvii
    // KO di fila) e' la stessa notizia detta peggio, e non si ripete.
    const ultimo = [host, container].filter(Boolean).sort((a, b) => (b.quando ?? 0) - (a.quando ?? 0))[0]
    if (ultimo && avvioStorto(ultimo) && !problemi.some((p) => p.tipo === 'dev-fermo')) {
      problemi.push({ tipo: 'avvio-storto', esito: ultimo.esito, lato: ultimo.lato ?? null, quando: ultimo.quando ?? null })
    }

    const pesanti = appPiuPesanti(sm?.appMb ?? {}, 3)
    const troppo = pesanti.find((a) => a.gb * 1024 >= sg.appPesanteMb)
    if (troppo) problemi.push({ tipo: 'app-pesante', app: troppo.nome, gb: troppo.gb, sogliaGb: Math.round(sg.appPesanteMb / 102.4) / 10 })

    const uso = usoDellaMacchina(sm)
    const vm = {
      gb: num(sm?.vmMemGb),
      impostataGb: num(sm?.vmMemImpostataGb),
      obiettivoGb: num(sm?.vmMemObiettivoGb),
      ramMacGb: num(sm?.ramMacGb),
      disponibileGb: num(sm?.memDisponibileGb),
      cpu: num(sm?.vmCpu),
    }
    const impostata = vm.impostataGb ?? vm.gb
    const ctx = {
      motore: uso.motore ?? null,
      vm,
      comandi,
      app: pesanti[0] ?? null,
      vmSotto: vm.obiettivoGb != null && impostata != null && impostata < vm.obiettivoGb - 0.5,
    }
    const completi = problemi
      .map((p) => ({ ...p, livello: LIVELLO[p.tipo] ?? 'warn' }))
      .sort((a, b) => rango(a) - rango(b))
      .map((p) => ({ ...p, azione: azioneDi(p, ctx) }))

    const utenti = [...new Set([sm?.utente, host?.utente, container?.utente, ...(host?.utenti ?? []), ...(container?.utenti ?? [])].filter(Boolean))]
    const visto = Math.max(0, host?.quando ?? 0, container?.quando ?? 0, sm?.quando ?? 0, Number(sal?.ultime?.[nome]) || 0) || null
    return {
      macchina: nome,
      utente: utenti[0] ?? null,
      altriNomi: utenti.slice(1),
      livello: completi[0]?.livello ?? 'ok',
      problemi: completi,
      visto,
      host,
      container,
      immagine: {
        digest: digestCorto(host?.immagine ?? container?.immagine),
        creata: host?.creata ?? container?.creata ?? null,
        giorni: indietro?.giorni ?? ritardi[0]?.giorni ?? null,
      },
      vm,
      motore: uso.motore,
      motoreIncerto: uso.motoreIncerto,
      app: pesanti,
      contenitori: sm?.contenitori ?? [],
      oom: sm ? { nuovi: sm.oomNuovi ?? 0, uccisi: sm.uccisiPerMemoria ?? [], quando: sm.oomQuando ?? null } : null,
      swapGb: sm?.swapMacMb != null ? Math.round(sm.swapMacMb / 102.4) / 10 : null,
      uso: { ...uso, ultimoUp: sm?.ultimoUp ?? null, ultimoUpdate: sm?.ultimoUpdate ?? null, doctor: sm?.doctor ?? null },
      // Nessuna riga di salute nelle 24 ore ne' nei sette giorni: dev-env che l'agent non ce l'ha
      // ancora, o Mac spento. Non e' un problema da card: e' un dato che manca, e si dice una volta.
      saluteAssente: !sm && !Number.isFinite(Number(sal?.ultime?.[nome])),
      saluteUltima: Number(sal?.ultime?.[nome]) || sm?.quando || null,
      serie: sal?.serie?.macchine?.[nome] ?? null,
      storia: battito.storia?.[nome] ?? [],
    }
  })

  macchine.sort(
    (a, b) =>
      RANGO[a.livello] - RANGO[b.livello] ||
      b.problemi.filter((p) => p.livello !== 'info').length - a.problemi.filter((p) => p.livello !== 'info').length ||
      a.macchina.localeCompare(b.macchina),
  )
  const daSistemare = macchine.filter((m) => m.livello === 'crit' || m.livello === 'warn').length
  return {
    configurato: true,
    saluteConfigurata: salute != null,
    macchine,
    totale: macchine.length,
    daSistemare,
    riferimento: { digest: digestCorto(riferimento.immagine), fonte: riferimento.fonte, data: dataRif },
    tuttiIndietro: tuttiIndietro(righe, riferimento),
    serie: sal?.serie ? { inizio: sal.serie.inizio, passoMs: sal.serie.passoMs, punti: sal.serie.punti } : null,
    soglie: sg,
    troncato: Boolean(sal?.troncato),
    errori: [heartbeat?.errore, salute?.errore].filter(Boolean),
  }
}

// La lettura vera: heartbeat (la stessa cache della pagina Accessi) e sette giorni di salute in una
// query sola, con la cache di due minuti delle altre letture.
export async function statoFlotta({ adesso = Date.now() } = {}) {
  const { accounts } = await resolveServices()
  const cfg = loadConfig().teleport
  if (!cfg) return { configurato: false }
  const cs = configSalute(cfg)
  const [heartbeat, salute] = await Promise.all([
    leggiHeartbeat(accounts, cfg),
    !cs
      ? null
      : conto(accounts, cs.account)
        ? cached('flotta:salute', 120_000, () =>
            teleport.saluteSettimana(conto(accounts, cs.account), { logGroup: cs.logGroup, giorni: 7, ore: 24 }),
          ).catch((err) => ({ errore: cleanAwsReason(err) }))
        : { errore: `account "${cs.account ?? '?'}" non configurato in accounts` },
  ])
  return {
    ...componiFlotta({ heartbeat, salute }, { adesso, soglie: soglieDevEnv(cfg), comandi: comandiDevEnv(cfg) }),
    sshCommand: cfg.sshCommand ?? null,
    auditNodeUrl: cfg.auditNodeUrl ?? null,
    auditUserUrl: cfg.auditUserUrl ?? null,
    webUrl: cfg.webUrl ?? null,
  }
}
