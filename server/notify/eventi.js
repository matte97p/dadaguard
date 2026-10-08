import { SQSClient, ReceiveMessageCommand, DeleteMessageBatchCommand } from '@aws-sdk/client-sqs'
import { clientOpts } from '../runtime/awsClient.js'
import { log } from '../log.js'
import { stripOrgEnv } from '../util/envToken.js'

// Gli EVENTI del quadro: quello che succede a un rilascio, detto nel momento in cui succede invece di
// essere scoperto al giro dopo. Il giro legge CodeBuild, ECS e GitHub da sé, ma è lento e irregolare
// (fra 25 secondi e 14 minuti misurati l'08/10/2026, con CloudTrail e GitHub dentro), e il 🧪 di un
// push arrivava minuti dopo il messaggio in canale. Qui arrivano tre cose, tutte in una coda SQS:
//
//   la CI          `{ fonte: 'ci', evento: 'test_avviati' | 'test_falliti', progetto, repo, commit,
//                  run, quando }`, dalle azioni `notifica-test-avviati` e `notifica-check-rossi`
//                  della CI, nello stesso momento della riga su Slack
//   CodeBuild      l'evento EventBridge `CodeBuild Build State Change` dei progetti `*-deploy`
//   ECS            l'evento EventBridge `ECS Deployment State Change`
//
// Un evento NON sostituisce la lettura del giro: la anticipa. Diventa una sovrapposizione sulla riga
// che vale finché il giro non sa la stessa cosa (o una più nuova), e al massimo per `TTL_*`. Se la coda
// si ferma, il quadro torna esattamente quello di prima, più lento.
//
// ⚠️ È l'unica cosa del quadro che SCRIVE su AWS: `DeleteMessage` sulla coda di Dadaguard, che è sua e
// non tocca l'infrastruttura che guarda. Senza cancellare, ogni messaggio tornerebbe dopo la visibilità.
//
// I messaggi della CI vengono da chiunque possa spingere su un ramo di rilascio, quindi si trattano
// come dati non fidati: entra solo quello che passa la forma (nomi, sha, indirizzi di github.com), e
// niente testo libero finisce sul canvas.
//
// Configurazione:
//   DADAGUARD_QUADRO_CODA   l'indirizzo della coda (`https://sqs.<regione>.amazonaws.com/<conto>/<nome>`).
//                           Senza, il quadro funziona come prima, solo coi giri

// Le sovrapposizioni scadono: un evento perso (il SUCCEEDED dopo un IN_PROGRESS) non deve tenere una
// riga ferma su ⏳. I test possono durare venti minuti; un deploy che resta in corso oltre mezz'ora il
// giro lo vede comunque da sé.
export const TTL_TEST_MS = 2 * 3_600_000
export const TTL_DEPLOY_MS = 30 * 60_000
// GitHub elenca un run qualche secondo dopo che è partito: una lettura fatta subito dopo l'evento può
// non vederlo ancora, e non vuol dire che i test siano finiti.
const RITARDO_GITHUB_MS = 90_000

const AMB = { production: 'produzione', prod: 'produzione', prd: 'produzione', staging: 'staging', stg: 'staging', stage: 'staging' }
// `<org>-<env>-<resto>`: l'ambiente è il token dopo l'organizzazione, come in util/envToken.js. Puro.
export function ambienteDaNome(nome = '') {
  const m = /^(?:[a-z0-9]+-)?(production|prod|prd|staging|stg|stage)-/i.exec(String(nome))
  return m ? AMB[m[1].toLowerCase()] : null
}

const NOME = /^[a-z0-9][a-z0-9._-]{0,99}$/i
const SHA = /^[0-9a-f]{7,40}$/i
const REPO = /^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9_.-]{1,100}$/i
const quandoValido = (x) => (x && Number.isFinite(Date.parse(x)) ? new Date(x).toISOString() : null)
const soloSe = (re, x) => (typeof x === 'string' && re.test(x) ? x : null)
const linkGithub = (x) => (typeof x === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(actions\/runs\/\d+|commit\/[0-9a-f]{7,40})$/i.test(x) ? x : null)
const linkConsole = (x) => (typeof x === 'string' && /^https:\/\/([a-z0-9-]+\.)?console\.aws\.amazon\.com\/[^\s()[\]<>]*$/i.test(x) ? x : null)
// Il servizio di un progetto `<org>-<env>-<servizio>-deploy`, col nome breve che usano le righe. Puro.
const servizioDaProgetto = (p) => stripOrgEnv(p).replace(/-deploy$/, '').replace(/^cron-/, '')

// Un messaggio della coda diventa un evento, o `null` se non è uno di quelli che il quadro capisce.
// L'evento: `{ tipo: 'test' | 'deploy', ambiente, servizio?, repo?, stato: 'in_corso' | 'fallito' |
// 'ok', da, sha?, url?, numero?, fase?, motivo?, log?, fonte }`. Puro/testabile.
export function normalizza(corpo) {
  let m = corpo
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m)
    } catch {
      return null
    }
  }
  if (!m || typeof m !== 'object') return null

  if (m.fonte === 'ci') {
    const progetto = soloSe(NOME, m.progetto)
    const ambiente = ambienteDaNome(progetto)
    const repo = soloSe(REPO, m.repo)
    const stato = m.evento === 'test_avviati' ? 'in_corso' : m.evento === 'test_falliti' ? 'fallito' : null
    const da = quandoValido(m.quando)
    if (!progetto || !progetto.endsWith('-deploy') || !ambiente || !repo || !stato || !da) return null
    return { tipo: 'test', fonte: 'ci', ambiente, servizio: servizioDaProgetto(progetto), repo: repo.toLowerCase(), stato, da, sha: soloSe(SHA, m.commit), url: linkGithub(m.run) }
  }

  if (m.source === 'aws.codebuild' && m['detail-type'] === 'CodeBuild Build State Change') {
    const d = m.detail ?? {}
    const progetto = soloSe(NOME, d['project-name'])
    const ambiente = ambienteDaNome(progetto)
    const stato = { IN_PROGRESS: 'in_corso', SUCCEEDED: 'ok', FAILED: 'fallito', STOPPED: 'fallito', FAULT: 'fallito', TIMED_OUT: 'fallito' }[d['build-status']]
    if (!progetto || !progetto.endsWith('-deploy') || !ambiente || !stato) return null
    const info = d['additional-information'] ?? {}
    const numero = Number.isInteger(info['build-number']) ? info['build-number'] : Number.isFinite(Number(info['build-number'])) ? Number(info['build-number']) : null
    // La fase in cui è morta: l'ultima con un esito che non è SUCCEEDED.
    const fasi = Array.isArray(info.phases) ? info.phases : []
    const rotta = stato === 'fallito' ? fasi.find((f) => f?.['phase-status'] && f['phase-status'] !== 'SUCCEEDED') : null
    return {
      tipo: 'deploy',
      fonte: 'codebuild',
      ambiente,
      servizio: servizioDaProgetto(progetto),
      stato,
      // L'ora dell'evento, non quella d'inizio della build: un SUCCEEDED è più nuovo dell'IN_PROGRESS.
      da: quandoValido(m.time) ?? quandoValido(info['build-start-time']),
      inizio: quandoValido(info['build-start-time']),
      numero,
      sha: soloSe(SHA, info['source-version']),
      fase: rotta && typeof rotta['phase-type'] === 'string' ? rotta['phase-type'].slice(0, 40) : null,
      log: linkConsole(info.logs?.['deep-link']),
    }
  }

  if (m.source === 'aws.ecs' && m['detail-type'] === 'ECS Deployment State Change') {
    const d = m.detail ?? {}
    // `arn:aws:ecs:<regione>:<conto>:service/<cluster>/<servizio>`
    const nome = soloSe(NOME, String(m.resources?.[0] ?? '').split('/').pop())
    const ambiente = ambienteDaNome(nome)
    const stato = { SERVICE_DEPLOYMENT_IN_PROGRESS: 'in_corso', SERVICE_DEPLOYMENT_COMPLETED: 'ok', SERVICE_DEPLOYMENT_FAILED: 'fallito' }[d.eventName]
    if (!nome || !ambiente || !stato) return null
    return {
      tipo: 'deploy',
      fonte: 'ecs',
      ambiente,
      servizio: stripOrgEnv(nome).replace(/^cron-/, '') || nome,
      stato,
      da: quandoValido(m.time) ?? quandoValido(d.updatedAt),
      motivo: stato === 'fallito' && typeof d.reason === 'string' ? d.reason.slice(0, 200) : null,
    }
  }
  return null
}

// La memoria degli eventi: per ogni riga l'ultimo, quello che conta. `registra` dice se l'evento ha
// cambiato qualcosa (un doppione o uno più vecchio no), così chi lo riceve aggiorna il quadro solo
// quando serve.
export function nuoviEventi() {
  const deploy = new Map() // ambiente|servizio → evento
  const test = new Map() // ambiente|owner/repo → evento
  return {
    registra(ev, ora = Date.now()) {
      if (!ev?.da) return false
      const [mappa, chiave] = ev.tipo === 'test' ? [test, `${ev.ambiente}|${ev.repo}`] : [deploy, `${ev.ambiente}|${ev.servizio}`]
      const prima = mappa.get(chiave)
      if (prima && Date.parse(prima.da) > Date.parse(ev.da)) return false
      if (prima && prima.da === ev.da && prima.stato === ev.stato) return false
      mappa.set(chiave, { ...ev, ricevuto: ora })
      return true
    },
    // Quello che vale ancora: il resto si dimentica qui.
    attivi(ora = Date.now()) {
      for (const [m, ttl] of [
        [deploy, TTL_DEPLOY_MS],
        [test, TTL_TEST_MS],
      ])
        for (const [k, ev] of m) if (ora - ev.ricevuto > ttl) m.delete(k)
      return { deploy, test }
    },
  }
}

// Gli stati dei test da GitHub con quelli arrivati dalla CI: `ambiente|owner/repo` → `{ stato, da,
// url, sha }`, la stessa forma di `statoDaRun`. Uno della CI vale finché GitHub non dice di più:
// - GitHub ha uno stato dello STESSO commit: vince GitHub, che vede tutti i workflow, tranne quando
//   l'evento dice che i check sono rossi (lo dice chi li ha visti fallire, anche se un altro workflow
//   di quel commit gira ancora)
// - GitHub ha uno stato di un altro commit nato DOPO l'evento: vince GitHub
// - GitHub è stato letto bene ben dopo l'evento e quel repository lì non ha niente: i test sono finiti
//   verdi (un verde non lascia stato, vedi `statoDaRun`), quindi l'evento non vale più
// `lettoAlle` è l'ultima lettura di GitHub riuscita, `null` se non c'è GitHub. Puro/testabile.
export function unisciTest(daGithub, eventiTest, { lettoAlle = null } = {}) {
  const out = new Map(daGithub ?? [])
  const stesso = (a, b) => Boolean(a && b && (a.startsWith(b) || b.startsWith(a)))
  for (const [k, ev] of eventiTest ?? []) {
    const g = out.get(k)
    if (g && stesso(g.sha, ev.sha) && ev.stato !== 'fallito') continue
    if (g && !stesso(g.sha, ev.sha) && Date.parse(g.da) >= Date.parse(ev.da)) continue
    if (!g && lettoAlle && lettoAlle - ev.ricevuto > RITARDO_GITHUB_MS) continue
    out.set(k, { stato: ev.stato, da: ev.da, url: ev.url ?? null, sha: ev.sha ?? null })
  }
  return out
}

// Quando il giro ha letto l'ultima cosa su una riga: l'evento è più vecchio di così, non dice niente
// di nuovo. Puro.
const tempo = (x) => (x ? Date.parse(x) || 0 : 0)
function lettoDalGiro(a) {
  return Math.max(tempo(a.quando), tempo(a.tentativo?.da))
}

// Il numero dell'ultima build che il giro conosce su quella riga. Puro.
const buildDelGiro = (a) => Math.max(a.tentativo?.numero ?? 0, a.come?.build ?? 0)

// Mette gli eventi di deploy sulle righe delle applicazioni del quadro, cambiando i dati della riga
// (non la riga resa): così canvas e List li raccontano con le stesse parole di un deploy visto dal giro.
// Un evento vale se è più nuovo di quello che il giro sa della riga:
// - una build che il giro conosce già con un numero più alto, o con lo stesso numero già finita, non
//   aggiunge niente
// - un evento più vecchio dell'ultimo fatto letto dal giro, nemmeno
// Una riga giù resta giù: il servizio che non risponde dice di più del deploy. Puro/testabile.
export function applicaEventi(q, eventiDeploy) {
  if (!eventiDeploy?.size) return q
  for (const [amb, qa] of Object.entries(q ?? {}))
    for (const a of qa?.app ?? []) {
      const ev = eventiDeploy.get(`${amb}|${a.servizio}`)
      if (!ev || a.stato === 'giu') continue
      if (tempo(ev.da) <= lettoDalGiro(a)) continue
      if (ev.numero) {
        const n = buildDelGiro(a)
        if (n > ev.numero) continue
        if (n === ev.numero && a.stato !== 'in_corso') continue
      }
      if (ev.stato === 'ok') {
        a.stato = 'ok'
        a.quando = ev.da
        a.tentativo = null
        if (ev.numero) a.come = { tipo: 'ci', build: ev.numero, durataMs: tempo(ev.inizio) ? tempo(ev.da) - tempo(ev.inizio) : null, chi: null }
        continue
      }
      a.stato = ev.stato
      a.tentativo = {
        // Un evento di ECS non ha build: è un rollout (un riavvio, una revisione nuova).
        numero: ev.numero ?? null,
        commit: ev.sha ?? null,
        fase: ev.fase ?? null,
        da: ev.inizio ?? ev.da,
        motivo: ev.motivo ?? null,
        log: ev.log ?? null,
        riavvio: ev.fonte === 'ecs',
        chi: null,
      }
      // `rigaDiApp` racconta un rollout senza build (`tentativo` nullo) come «rollout»: per ECS in corso
      // è la parola giusta.
      if (ev.fonte === 'ecs' && ev.stato === 'in_corso') {
        a.tentativo = null
        a.quando = ev.da
      }
    }
  return q
}

// Il lettore della coda: chiede a SQS in attesa lunga (20 secondi, il massimo: una risposta arriva
// appena c'è un messaggio, e una coda vuota costa una richiesta ogni 20 secondi), registra quello che
// capisce, cancella tutto quello che ha letto (anche quello che non capisce: tornerebbe per sempre) e
// chiama `quandoCambia` se qualcosa è cambiato. Non si ferma mai da solo: un errore aspetta e riprova.
// `deps.client` e `deps.dormi` per le prove. Restituisce `{ ferma }`.
export function ascoltaCoda(url, eventi, quandoCambia, deps = {}) {
  const client = deps.client ?? new SQSClient(clientOpts({ region: regioneDaUrl(url) }))
  const dormi = deps.dormi ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()))
  let attivo = true
  let erroreDetto = null
  ;(async () => {
    log.info('quadro: eventi dalla coda attivi', { coda: url.split('/').pop() })
    while (attivo) {
      try {
        const r = await client.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 20 }))
        const msgs = r.Messages ?? []
        let cambiato = false
        for (const m of msgs) {
          const ev = normalizza(m.Body)
          if (ev && eventi.registra(ev)) cambiato = true
        }
        if (msgs.length)
          await client.send(new DeleteMessageBatchCommand({ QueueUrl: url, Entries: msgs.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })) }))
        if (erroreDetto) log.info('quadro: coda degli eventi di nuovo leggibile')
        erroreDetto = null
        if (cambiato) quandoCambia()
        if (deps.unGiro) attivo = false
      } catch (err) {
        if (erroreDetto !== err.message) log.warn('quadro: coda degli eventi non letta, il quadro va avanti coi giri', { err: err.message })
        erroreDetto = err.message
        if (deps.unGiro) attivo = false
        else await dormi(30_000)
      }
    }
  })()
  return {
    ferma() {
      attivo = false
    },
  }
}

// `https://sqs.eu-central-1.amazonaws.com/123/nome` → `eu-central-1`. Puro.
export function regioneDaUrl(url) {
  return /sqs\.([a-z0-9-]+)\.amazonaws\.com/.exec(String(url))?.[1] ?? undefined
}
