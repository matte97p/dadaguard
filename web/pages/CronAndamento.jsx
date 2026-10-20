import { useEffect, useMemo, useRef, useState } from 'react'
import { Verdetto, Card, Lista, Pill, Tessere, Tessera, GraficoEventi, PiccoliMultipli, Legenda } from '../ui/index.js'
import { usePoll } from '../usePoll.js'
import { useSchermoPieno } from '../ui/useSchermoPieno.js'
import { matchesAny } from '../filters.js'
import { etichettaFascia, numero } from '../grafici.js'
import { durata, fmtAgo } from '../format.js'
import { serieCron, kpiCron, righeTabella, perCron } from '../../shared/cronSerie.js'
import './rilasci.css'

// Vista ANDAMENTO della pagina Cron: com'e' andata, giorno per giorno, negli ultimi 7 o 30 giorni. La
// stessa dashboard dei tempi dei rilasci (TempiPage.jsx), con le stesse regole per leggersi al volo:
// titoli che sono la domanda, «di solito» e «giorni lenti» invece di mediana e p90, durate arrotondate.
//
// I dati arrivano da /api/runs/storico gia' in fasce, una riga per cron (vedi server/cronStorico.js: le
// Lambda dalle metriche, i job ECS dagli stream, niente righe di log); le somme e i filtri si fanno qui
// con shared/cronSerie.js, cosi' scegliere un cron o un account non rifa' il giro di CloudWatch.
//
// I colori dei pezzi sono quelli di stato, e qui e' giusto: il grafico dice proprio com'e' finita. Il
// grigio e' «esito non letto» (le corse dei job ECS), che non e' ne' bene ne' male.

const GIORNI = [7, 30]
const COLORE = { riuscite: 'var(--ok)', fallite: 'var(--crit)', saltate: 'var(--warn)', nonLette: 'var(--chart-neutro)' }

// «il 96%» ma «l'87%» e «lo 0%»: in italiano l'articolo segue come si legge il numero (otto, undici,
// ottanta, zero).
const articoloPct = (n) => (n === 0 ? 'lo ' : n === 1 || n === 8 || n === 11 || (n >= 80 && n <= 89) ? "l'" : 'il ')

// Il fuso del browser: le fasce del server cadono sulla mezzanotte di chi guarda.
function fusoBrowser() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    return ''
  }
}

// Una cella della tabella: il numero grande, la spiegazione sotto, l'etichetta solo sul telefono (dove
// le intestazioni delle colonne non ci sono). Come nella tabella dei tempi.
function Cella({ etichetta, valore, sotto, livello }) {
  return (
    <span className="rl-tempo">
      <small className="rl-tempo-et">{etichetta}</small>
      <b className={livello ? `ui-t-${livello}` : undefined}>{valore ?? '-'}</b>
      {sotto && <small className="ui-mute">{sotto}</small>}
    </span>
  )
}

function TabellaCron({ righe, t, d, lang, passoMs, etichettaConto, onApri }) {
  const col = (k) => t(`cronStorico.tab.${k}`)
  const giorno = (ms) => new Date(ms).toLocaleDateString(lang === 'it' ? 'it-IT' : 'en-GB', { day: 'numeric', month: 'short' })
  return (
    <Lista
      colonne={[col('cron'), col('corse'), col('fallite'), col('saltate'), col('solito'), col('lenti'), col('ultima')]}
      griglia="minmax(0,1.5fr) repeat(6, minmax(80px,1fr))"
      grigliaMobile="minmax(0,1fr) minmax(0,1fr)"
      vuoto={t('cronStorico.vuoto')}
    >
      {righe.map((r) => {
        const { tot } = r
        const tipo = t(`runs.type.${r.tipo === 'lambda' ? 'lambda' : 'ecs'}`)
        return (
          <button key={r.k} type="button" className="ui-row ui-row-btn rl-tempi-riga" title={t('cronStorico.apri')} onClick={() => onApri?.(r.k)}>
            <span className="ui-name">
              {r.nome}
              <small>{[etichettaConto(r.account), tipo, r.acceso ? null : t('cronStorico.spento')].filter(Boolean).join(' · ')}</small>
              {r.errore && <small className="ui-t-crit">{r.errore}</small>}
              {r.lento && (
                <span title={t('cronStorico.lentoTip', { dopo: d(r.lento.dopo), prima: d(r.lento.prima) })}>
                  <Pill livello="warn">{t('cronStorico.lento')}</Pill>
                </span>
              )}
            </span>
            <Cella
              etichetta={col('corse')}
              valore={r.errore ? null : String(tot.corse)}
              sotto={r.copertoDa ? t('cronStorico.storicoDa', { quando: giorno(r.copertoDa) }) : null}
            />
            <Cella
              etichetta={col('fallite')}
              valore={tot.fallite == null ? null : String(tot.fallite)}
              sotto={tot.fallite == null ? (r.errore ? null : t('cronStorico.nonLetto')) : tot.conEsito ? t('cronStorico.suNoti', { n: tot.fallite, tot: tot.conEsito }) : null}
              livello={tot.fallite > 0 ? 'crit' : null}
            />
            <Cella
              etichetta={col('saltate')}
              valore={tot.saltate == null ? null : String(tot.saltate)}
              sotto={tot.saltate == null && !r.errore ? t(r.acceso ? 'cronStorico.nonCalcolabile' : 'cronStorico.spento') : null}
              livello={tot.saltate > 0 ? 'warn' : null}
            />
            <Cella etichetta={col('solito')} valore={r.finestra?.p50 != null ? d(r.finestra.p50) : null} />
            <Cella etichetta={col('lenti')} valore={r.finestra?.p90 != null ? d(r.finestra.p90) : null} />
            {/* Dalle metriche di Lambda si sa la FASCIA dell'ultima corsa, non l'ora: si dice quella. */}
            <Cella
              etichetta={col('ultima')}
              valore={!r.ultima ? null : r.ultima.esatta ? fmtAgo(r.ultima.t, t) : etichettaFascia(r.ultima.t, passoMs, lang)}
              sotto={r.ultima && !r.ultima.esatta ? t('cronStorico.dalleMetriche') : null}
            />
          </button>
        )
      })}
    </Lista>
  )
}

export default function CronAndamento({ t = (k) => k, lang, refreshKey, accountFilter = [], onApriCron }) {
  const [giorni, setGiorni] = useState(7)
  const [scelto, setScelto] = useState('')
  useSchermoPieno()
  const tz = useMemo(fusoBrowser, [])
  const { data, loading, error, refresh } = usePoll(`/api/runs/storico?giorni=${giorni}&tz=${encodeURIComponent(tz)}&lang=${lang}`, { intervalMs: 600_000 })

  const seenRk = useRef(refreshKey)
  useEffect(() => {
    if (refreshKey !== seenRk.current) {
      seenRk.current = refreshKey
      refresh()
    }
  }, [refreshKey, refresh])

  const d = (ms) => durata(ms, t)
  const etichettaConto = (k) => data?.account?.[k]?.label ?? k
  const tutti = useMemo(() => (data?.crons ?? []).filter((c) => matchesAny(c.account, accountFilter)), [data, accountFilter])
  // Un cron scelto che il filtro dell'account ha tolto non filtra «niente»: si torna a tutti.
  const sceltoValido = tutti.some((c) => c.k === scelto) ? scelto : ''
  const righe = useMemo(() => (sceltoValido ? tutti.filter((c) => c.k === sceltoValido) : tutti), [tutti, sceltoValido])
  const g = useMemo(() => ({ inizio: data?.inizio, passoMs: data?.passoMs, punti: data?.punti ?? 0 }), [data])
  const serie = useMemo(() => serieCron(righe, g), [righe, g])
  const kpi = useMemo(() => kpiCron(righe), [righe])
  const tabella = useMemo(() => righeTabella(righe), [righe])
  const multipli = useMemo(() => perCron(righe), [righe])

  const finestra = t(`cronStorico.finestra.${giorni}`)
  const attesa = loading && !data
  const uno = righe.length === 1 ? righe[0] : null

  // Il verdetto: la quota delle volte senza una fallita o una saltata (vedi `kpiCron`). Con corse di job
  // ECS dentro, di cui l'esito non si legge, la frase non dice «bene» ma «senza problemi noti»: quelle
  // corse sono partite, non riuscite.
  let forte = null
  let resto = null
  if (attesa) resto = t('cronStorico.v.attesa')
  else if (kpi.noti) {
    const pct = { nome: uno?.nome, pct: kpi.quotaBene, art: articoloPct(kpi.quotaBene) }
    forte = t(`cronStorico.v.forte${uno ? 'Uno' : ''}${kpi.nonLette ? 'Noti' : ''}`, pct)
    const quale = kpi.fallite && kpi.saltate ? 'resto' : kpi.fallite ? 'restoF' : kpi.saltate ? 'restoS' : 'restoPulito'
    resto = t(`cronStorico.v.${quale}`, { f: kpi.fallite, s: kpi.saltate, finestra })
  } else resto = t('cronStorico.v.vuoto', { finestra })
  const dettaglio = attesa || !kpi.corse ? null : t(kpi.nonLette ? 'cronStorico.v.dettaglioNonLette' : 'cronStorico.v.dettaglio', { n: kpi.corse, c: righe.length, x: kpi.nonLette })

  const voci = [
    { k: 'riuscite', valori: serie.riuscite },
    { k: 'fallite', valori: serie.fallite },
    { k: 'saltate', valori: serie.saltate },
    // Il grigio solo se c'e': una voce di legenda per un colore che non compare e' rumore.
    ...(kpi.nonLette ? [{ k: 'nonLette', valori: serie.nonLette }] : []),
  ].map((s) => ({ ...s, etichetta: t(`cronStorico.${s.k}`), colore: COLORE[s.k] }))
  const trend = (cosa, valori, forma = 'barre') => ({ valori, forma, descrizione: t('cronStorico.trend', { cosa }) })
  const f = kpi.tassoFallite
  // Sotto il 10% con un decimale: lo 0,4% di una Lambda ogni quarto d'ora sono decine di fallite, e «0%»
  // in arancio non si capirebbe.
  const pctFallite = f == null ? null : f > 0 && f < 0.1 ? `${numero(f * 100, lang, 1)}%` : `${Math.round(f * 100)}%`
  const qualcosa = kpi.corse > 0 || kpi.saltate > 0

  return (
    <div className="rl-pagina tp-pagina">
      <Verdetto livello={null} forte={forte} resto={resto} dettaglio={dettaglio} />

      {error && <div className="ui-readwarn">{error}</div>}
      {Object.entries(data?.account ?? {})
        .filter(([k, a]) => a.error && matchesAny(k, accountFilter))
        .map(([k, a]) => (
          <div key={k} className="ui-readwarn">
            {t('rilasci.nonLeggibile', { conto: a.label ?? k, errore: a.error })}
          </div>
        ))}

      {/* I filtri in una riga sola, sopra a tutti i grafici: valgono per tutta la vista. */}
      <div className="rl-tools">
        <div className="ui-seg" role="group" aria-label={t('rilasci.finestra')}>
          {GIORNI.map((n) => (
            <button key={n} type="button" aria-pressed={giorni === n} onClick={() => setGiorni(n)}>
              {t(`cronStorico.finestraBreve.${n}`)}
            </button>
          ))}
        </div>
        {/* Al massimo largo quanto la riga: un nome di cron lungo non deve far scorrere la pagina sul telefono. */}
        <select className="tp-select" style={{ maxWidth: '100%' }} aria-label={t('cronStorico.cron')} value={sceltoValido} onChange={(e) => setScelto(e.target.value)}>
          <option value="">{t('cronStorico.tutti')}</option>
          {tutti.map((c) => (
            <option key={c.k} value={c.k}>
              {`${c.nome} · ${etichettaConto(c.account)}`}
            </option>
          ))}
        </select>
      </div>

      {attesa ? null : (
        <>
          <Tessere etichetta={t('cronStorico.tessere')}>
            <Tessera
              etichetta={t('cronStorico.t.corse')}
              valore={String(kpi.corse)}
              sotto={kpi.nonLette ? t('cronStorico.t.corseSotto', { n: kpi.nonLette }) : null}
              trend={trend(t('cronStorico.t.corse'), serie.corse)}
            />
            <Tessera
              etichetta={t('cronStorico.t.fallite')}
              valore={pctFallite}
              livello={f >= 0.1 ? 'crit' : f > 0 ? 'warn' : null}
              sotto={f != null ? t('cronStorico.suNoti', { n: kpi.fallite, tot: kpi.conEsito }) : kpi.nonLette ? t('cronStorico.nonLetto') : null}
              trend={trend(t('cronStorico.t.fallite'), serie.fallite)}
            />
            <Tessera
              etichetta={t('cronStorico.t.saltate')}
              valore={String(kpi.saltate)}
              livello={kpi.saltate ? 'warn' : null}
              sotto={t('cronStorico.t.saltateSotto')}
              trend={trend(t('cronStorico.t.saltate'), serie.saltate)}
            />
            {/* L'andamento senza le fasce vuote: e' una direzione in 90 pixel, e coi buchi una serie rada
                (un cron al giorno sulla settimana) sparisce. */}
            <Tessera
              etichetta={t('cronStorico.t.durata')}
              title={uno ? undefined : t('cronStorico.t.durataTip')}
              valore={kpi.durata?.p50 != null ? d(kpi.durata.p50) : null}
              sotto={kpi.durata?.p90 != null ? t('cronStorico.t.lenti', { d: d(kpi.durata.p90) }) : null}
              trend={trend(t('cronStorico.t.durata'), serie.p50.filter((v) => v != null), 'linea')}
            />
          </Tessere>

          {qualcosa && (
          <Card titolo={t('cronStorico.pila.titolo')} nota={t(g.passoMs < 86_400_000 ? 'cronStorico.pila.nota.sei' : 'cronStorico.pila.nota.giorno')}>
            <Legenda voci={voci.map((s) => ({ etichetta: s.etichetta, colore: s.colore }))} />
            <GraficoEventi
              andamento={serie}
              serie={voci}
              lang={lang}
              t={t}
              aria={t('cronStorico.pila.titolo')}
              extra={(i) => [{ etichetta: t('cronStorico.t.durata'), valore: serie.p50[i] == null ? '-' : d(serie.p50[i]) }]}
            />
          </Card>
          )}

          {multipli.righe.length > 0 && (
            <Card titolo={t('cronStorico.multipli.titolo')} nota={t('cronStorico.multipli.nota')}>
              <PiccoliMultipli
                serie={serie}
                righe={multipli.righe.map((r) => ({
                  k: r.k,
                  etichetta: `${r.nome} · ${etichettaConto(r.account)}`,
                  valori: r.p50,
                  dominio: multipli.dominio,
                  colore: 'var(--chart-1)',
                  ponti: true,
                  formato: d,
                }))}
                lang={lang}
                t={t}
                aria={t('cronStorico.multipli.titolo')}
                ultimoTesto={t('cronStorico.multipli.ultimo')}
              />
              {multipli.altri > 0 && <p className="ui-note">{t('cronStorico.multipli.altri', { n: multipli.altri })}</p>}
            </Card>
          )}

          <Card titolo={t('cronStorico.tabella.titolo')} nota={t('cronStorico.tabella.nota')}>
            <TabellaCron righe={tabella} t={t} d={d} lang={lang} passoMs={g.passoMs} etichettaConto={etichettaConto} onApri={onApriCron} />
            <p className="ui-note">{t('cronStorico.notaFonti')}</p>
          </Card>
        </>
      )}
    </div>
  )
}
