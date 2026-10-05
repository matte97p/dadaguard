import { Lista, Pill } from '../ui/index.js'
import { fmtMs, fmtSchedule } from '../format.js'
import {
  prettyBedrock,
  splitFamily,
  familyPrefixes,
  serviceKey,
  isNonEuInference,
  omonimiVisibili,
  chiaveVisibile,
  distintivo,
} from '../serviceName.js'
import { livelloServizio, ownerServizio, teamServizio, rangoLivello } from '../adattatori.js'
import { SIGLA, controlliDi, cosaSuccede, altriProblemi } from '../servizi.js'
import { latencyOf } from './signals.jsx'
import './servizi.css'

// La lista della flotta: una riga per servizio, come nel resto della nuova interfaccia. Una riga
// dice in quest'ordine com'e' messo, cos'e', cosa succede, a chi tocca, come vanno i controlli e
// quanto ci mette. Il dettaglio (controlli spiegati, cosa fare, log, link) sta nel pannello, che si
// apre con un clic su tutta la riga: il bersaglio grande e' meta' del lavoro su una lista densa.
//
// Nomi DUPLICATI, e non solo fra account (`backend` esiste in staging e in produzione): anche dentro
// un account, dove una ECS e il suo ALB portano lo stesso nome. La chiave di riga e' `serviceKey`,
// l'identita' della risorsa, mai il nome: due righe con la stessa chiave lasciano righe fantasma.

// Etichetta della pillola: sui problemi il controllo colpevole («Non risponde», «Allarme»), che e'
// la prima cosa che si vuole sapere; altrove il livello a parole.
export function etichettaServizio(s, t) {
  const l = livelloServizio(s)
  if ((l === 'crit' || l === 'warn') && s.cause) {
    const k = `svc.causa.${s.cause}`
    const v = t(k)
    if (v !== k) return v
  }
  return t(`home.liv.${l}`)
}

// Ordine: dal piu' grave, poi per nome. I problemi si vedono senza scorrere.
export const perGravita = (a, b) =>
  rangoLivello(livelloServizio(a)) - rangoLivello(livelloServizio(b)) || String(a.name).localeCompare(String(b.name))

// Famiglie calcolate PER ACCOUNT: mescolando gli account il prefisso comune si riduce al minimo
// («acme-») e la testa non compatta piu' niente.
export function famigliePerAccount(services) {
  const m = new Map()
  for (const s of services) {
    const k = s.account?.key ?? '-'
    if (!m.has(k)) m.set(k, [])
    if (s.type !== 'bedrock') m.get(k).push(s.name)
  }
  for (const [k, names] of m) m.set(k, familyPrefixes(names))
  return m
}

// Il nome come si mostra: testa di famiglia muta e coda in evidenza; i Bedrock col loro nome
// parlante e il profilo di inferenza, in rosso quando puo' uscire dall'UE (e' un vincolo di contratto).
export function NomeServizio({ s, famiglie, t }) {
  const bedrock = s.type === 'bedrock' ? prettyBedrock(s.name) : null
  const { family, tail } = bedrock ? { family: null, tail: bedrock.name ?? s.name } : splitFamily(s.name, famiglie)
  return (
    <span title={s.name}>
      {family && <span className="ui-faint">{family}</span>}
      {tail}
      {bedrock?.scope && (
        <>
          {' '}
          <Pill livello={isNonEuInference(s) ? 'crit' : 'off'} title={isNonEuInference(s) ? t('bedrock.nonEuHint') : s.name}>
            {bedrock.scope}
          </Pill>
        </>
      )}
    </span>
  )
}

export function tipoLabel(ty, t) {
  if (!ty) return null
  const k = `type.${ty}`
  const l = t(k)
  return l === k ? ty : l
}

export function latenzaTesto(s, t) {
  const l = latencyOf(s)
  if (!l) return null
  // La misura della sonda include rete e Cloudflare: etichettata, per non confrontarla con quella
  // che il servizio misura di suo.
  return l.source === 'metric' ? (l.metric?.value ?? fmtMs(l.ms)) : `${fmtMs(l.ms)} ${t('col.latency.probe')}`
}

export default function ServicesTable({ services, onOpen, t }) {
  const famiglie = famigliePerAccount(services)
  const righe = [...services].sort(perGravita)
  // Righe indistinguibili a occhio (stesso nome, stesso account): solo a quelle si aggiunge tipo e
  // cluster, su tutte sarebbe rumore.
  const ambigue = omonimiVisibili(righe)

  return (
    <div className="sv-lista">
      <Lista
        colonne={[
          t('svc.col.stato'),
          t('svc.col.servizio'),
          t('svc.col.cosa'),
          t('svc.col.diChi'),
          t('svc.col.controlli'),
          t('svc.col.latenza'),
          '',
        ]}
        vuoto={t('svc.vuoto')}
      >
        {righe.map((s) => {
          const livello = livelloServizio(s)
          const cadenza = s.checks?.runtime?.schedule ? fmtSchedule(s.checks.runtime.schedule, t) : null
          const sotto = [s.account?.label, tipoLabel(s.type, t), ambigue.has(chiaveVisibile(s)) ? distintivo(s) : null, cadenza]
            .filter(Boolean)
            .join(' · ')
          const altri = altriProblemi(s)
          const controlli = controlliDi(s)
          const lat = latenzaTesto(s, t)
          return (
            <button
              key={serviceKey(s)}
              type="button"
              className="ui-row ui-row-btn sv-row"
              data-service={s.name}
              onClick={() => onOpen?.(s)}
            >
              <Pill livello={livello}>{etichettaServizio(s, t)}</Pill>
              <span className="ui-nm">
                <span className="ui-kicon">{SIGLA[s.type] ?? '·'}</span>
                <span className="ui-name">
                  <NomeServizio s={s} famiglie={famiglie.get(s.account?.key ?? '-')} t={t} />
                  {sotto && <small>{sotto}</small>}
                </span>
              </span>
              <span className="ui-what">
                {cosaSuccede(s) ?? <span className="ui-faint">{t('svc.nienteDaDire')}</span>}
                {altri > 0 && <span className="ui-hint">{t('svc.altriControlli', { n: altri })}</span>}
              </span>
              <span className="ui-who">
                <b>{teamServizio(s) ?? t(`home.owner.${ownerServizio(s)}`)}</b>
              </span>
              <span
                className="sv-checks"
                title={controlli.map((c) => `${t(`svc.ck.${c.chiave}`)}: ${t(`home.liv.${c.livello}`)}`).join('\n')}
              >
                {controlli.map((c) => (
                  <i key={c.chiave} className={`ui-bg-${c.livello}`} />
                ))}
              </span>
              <span className="ui-mono ui-mute sv-lat">
                {livello === 'off' && !lat ? <span className="ui-faint">{t('home.liv.off').toLowerCase()}</span> : (lat ?? '')}
              </span>
              <span className="ui-go">›</span>
            </button>
          )
        })}
      </Lista>
    </div>
  )
}
