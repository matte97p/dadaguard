import { useEffect, useMemo, useRef, useState } from 'react'
import { Verdetto, Card, Lista, Pill, Tessere, Tessera, GraficoEventi, GraficoBanda, PiccoliMultipli, Legenda } from '../ui/index.js'
import { fmtMs } from '../format.js'
import { usePoll } from '../usePoll.js'
import { matchesAny, listaDaUrl } from '../filters.js'
import { numero } from '../grafici.js'
import { PEZZI, griglia, serieTempi, kpiTempi, perServizio } from '../../shared/tempiSerie.js'
import './rilasci.css'

// Pagina TEMPI: quanto ci mette un rilascio e dove perde tempo, nel tempo. Una dashboard nello stile
// di Grafana: le tessere della finestra in cima, poi dove va il tempo fascia per fascia, la durata con
// la sua fascia fino al p90, i rilasci riusciti e falliti, un piccolo grafico per servizio e la tabella.
// I punti (uno per build) arrivano da /api/deploys/storico; le serie le fa shared/tempiSerie.js qui nel
// browser, cosi' cambiare servizio o ambiente non rifa' il giro di CodeBuild e GitHub.

const GIORNI = [7, 30, 90]
// Il colore segue il pezzo, in ordine fisso: CI, attese (grigio: tempo in cui non lavora nessuno),
// build, deploy. Sono i quattro colori dei grafici di app.css, gia' validati per chiaro e scuro.
const COLORE = { ci: 'var(--chart-1)', attese: 'var(--chart-neutro)', build: 'var(--chart-2)', deploy: 'var(--chart-3)' }

// I grafici lavorano in MINUTI: l'asse tondo (1, 2, 5, 10) cade su minuti tondi, in millisecondi
// cadrebbe su 8m 20s.
const inMin = (v) => (v == null ? null : v / 60_000)
const fmtMin = (v) => (v == null ? '-' : v === 0 ? '0' : fmtMs(v * 60_000))

const TEMPI_SEGMENTI = ['ci', 'attesa', 'coda', 'build', 'deploy', 'lead']
const COLONNE_TEMPI = `minmax(0,1.3fr) repeat(${TEMPI_SEGMENTI.length + 4}, minmax(64px,1fr))`
const COLONNE_TEMPI_M = 'minmax(0,1fr) minmax(0,1fr)'

// Una cella della tabella: mediana grande, p90 sotto. L'etichetta serve sul telefono, dove
// l'intestazione delle colonne non c'e'.
function Cella({ etichetta, valore, sotto, livello, titolo }) {
  return (
    <span className="rl-tempo" title={titolo}>
      <small className="rl-tempo-et">{etichetta}</small>
      <b className={`ui-mono${livello ? ` ui-t-${livello}` : ''}`}>{valore ?? '-'}</b>
      {sotto && <small className="ui-mute">{sotto}</small>}
    </span>
  )
}

function TabellaTempi({ righe, t }) {
  const col = (k) => t(`rilasci.dep.tempi.col.${k}`)
  return (
    <Lista
      colonne={[t('rilasci.dep.col.servizio'), ...TEMPI_SEGMENTI.map(col), col('falliti'), col('settimana'), col('ripristino'), col('daStaging')]}
      griglia={COLONNE_TEMPI}
      grigliaMobile={COLONNE_TEMPI_M}
      vuoto={t('rilasci.dep.tempi.vuoto')}
    >
      {righe.map((r) => {
        const f = r.fallimento
        return (
          <div key={`${r.account}/${r.servizio}`} className="ui-row rl-tempi-riga">
            <span className="ui-name">
              {r.servizio}
              <small>{[r.accountLabel, t('rilasci.dep.tempi.campioni', { n: r.campioni })].join(' · ')}</small>
              {r.lenta && (
                <span title={t('rilasci.dep.tempi.lentaTip', { d: fmtMs(r.lenta.durationMs), p90: fmtMs(r.lenta.p90), build: r.lenta.build ?? '?' })}>
                  <Pill livello="warn">{t('rilasci.dep.tempi.lenta')}</Pill>
                </span>
              )}
            </span>
            {TEMPI_SEGMENTI.map((k) => (
              <Cella key={k} etichetta={col(k)} valore={r[k] ? fmtMs(r[k].p50) : null} sotto={r[k] ? `p90 ${fmtMs(r[k].p90)}` : null} />
            ))}
            <Cella
              etichetta={col('falliti')}
              valore={f ? `${Math.round(f.tasso * 100)}%` : null}
              sotto={f ? t('rilasci.dep.tempi.suFiniti', { n: f.falliti, tot: f.finiti }) : null}
              livello={f && f.tasso >= 0.25 ? 'crit' : f && f.tasso > 0.1 ? 'warn' : null}
            />
            <Cella etichetta={col('settimana')} valore={r.settimana ? String(r.settimana.n) : null} />
            <Cella etichetta={col('ripristino')} valore={r.ripristino ? fmtMs(r.ripristino.p50) : null} sotto={r.ripristino ? t('rilasci.dep.tempi.volte', { n: r.ripristino.n }) : null} />
            <Cella
              etichetta={col('daStaging')}
              valore={r.daStaging ? fmtMs(r.daStaging.p50) : null}
              sotto={r.daStaging ? `p90 ${fmtMs(r.daStaging.p90)}` : r.ambiente === 'produzione' ? t('rilasci.dep.tempi.nonAbbinato') : null}
            />
          </div>
        )
      })}
    </Lista>
  )
}

export default function TempiPage({ t = (k) => k, lang, refreshKey, accountFilter = [] }) {
  const [giorni, setGiorni] = useState(30)
  // Deep-link `?service=a,b`, come la pagina Deploy.
  const [servizi, setServizi] = useState(() => (typeof window === 'undefined' ? [] : listaDaUrl(window.location.search, 'service')))
  // Cosa misurano la linea e i piccoli multipli: dal push a in produzione, o la sola build CodeBuild.
  // Senza GitHub il push non si vede, e si parte dalla build.
  const [misura, setMisura] = useState('lead')
  const { data, loading, error, refresh } = usePoll(`/api/deploys/storico?giorni=${giorni}&lang=${lang}`, { intervalMs: 600000 })

  const seenRk = useRef(refreshKey)
  useEffect(() => {
    if (refreshKey !== seenRk.current) {
      seenRk.current = refreshKey
      refresh()
    }
  }, [refreshKey, refresh])

  const etichettaConto = (k) => data?.account?.[k]?.label ?? k
  const tutti = useMemo(() => (data?.punti ?? []).filter((p) => matchesAny(p.a, accountFilter)), [data, accountFilter])
  const elencoServizi = useMemo(() => [...new Set(tutti.map((p) => p.s))].sort(), [tutti])
  const punti = useMemo(() => tutti.filter((p) => matchesAny(p.s, servizi)), [tutti, servizi])
  const righe = useMemo(() => (data?.righe ?? []).filter((r) => matchesAny(r.account, accountFilter) && matchesAny(r.servizio, servizi)), [data, accountFilter, servizi])

  const g = useMemo(() => griglia({ giorni }), [giorni, data])
  const serie = useMemo(() => serieTempi(punti, g), [punti, g])
  const kpi = useMemo(() => kpiTempi(punti, { giorni }), [punti, giorni])
  const conLead = punti.some((p) => p.lead != null)
  const campo = misura === 'lead' && conLead ? 'lead' : 'totale'
  const multipli = useMemo(() => perServizio(punti, g, { campo }), [punti, g, campo])
  const linea = campo === 'lead' ? serie.lead : serie.totale

  const finestra = t(`tempi.finestra.${giorni}`)
  const pz = Object.fromEntries(serie.pezzi.map((p) => [p.k, p.valori]))
  const tessera = (k, r) => ({ valore: r ? fmtMs(r.p50) : null, sotto: r ? `p90 ${fmtMs(r.p90)}` : null, trend: { valori: pz[k] ?? [], descrizione: t('tempi.trend', { cosa: t(`tempi.pezzo.${k}`) }) } })
  const f = kpi.falliti
  const testa = kpi.lead ?? kpi.totale

  return (
    <div className="rl-pagina">
      <Verdetto
        livello={null}
        forte={loading && !data ? null : testa ? t(kpi.lead ? 'tempi.v.lead' : 'tempi.v.totale', { d: fmtMs(testa.p50) }) : null}
        resto={loading && !data ? t('rilasci.dep.v.attesa') : testa ? t('tempi.v.resto', { p90: fmtMs(testa.p90), n: testa.n, finestra }) : t('tempi.v.vuoto', { finestra })}
        dettaglio={t('tempi.v.dettaglio')}
      />

      {error && <div className="ui-readwarn">{error}</div>}
      {Object.entries(data?.account ?? {})
        .filter(([, a]) => a.error)
        .map(([k, a]) => (
          <div key={k} className="ui-readwarn">
            {t('rilasci.nonLeggibile', { conto: a.label ?? k, errore: a.error })}
          </div>
        ))}
      {data?.ciNota === 'senza-app' && <p className="ui-note">{t('rilasci.dep.tempi.senzaApp')}</p>}
      {data?.ciNota === 'parziale' && <div className="ui-readwarn">{t('rilasci.dep.tempi.parziale', { repo: (data.nonLetti ?? []).join(', ') })}</div>}
      {data?.ciNota === 'job-in-arrivo' && <p className="ui-note">{t('tempi.jobInArrivo')}</p>}

      {/* I filtri in una riga sola, sopra a tutti i grafici: valgono per tutta la pagina. */}
      <div className="rl-tools">
        <div className="ui-seg" role="group" aria-label={t('rilasci.finestra')}>
          {GIORNI.map((n) => (
            <button key={n} type="button" aria-pressed={giorni === n} onClick={() => setGiorni(n)}>
              {t(`tempi.finestraBreve.${n}`)}
            </button>
          ))}
        </div>
        <select className="tp-select" aria-label={t('tempi.servizio')} value={servizi.length === 1 ? servizi[0] : ''} onChange={(e) => setServizi(e.target.value ? [e.target.value] : [])}>
          <option value="">{t('tempi.tuttiServizi')}</option>
          {elencoServizi.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {conLead && (
          <div className="ui-seg" role="group" aria-label={t('tempi.misura')}>
            {['lead', 'totale'].map((m) => (
              <button key={m} type="button" aria-pressed={campo === m} onClick={() => setMisura(m)}>
                {t(`tempi.misura.${m}`)}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading && !data ? (
        <p className="ui-mute">{t('rilasci.dep.v.attesa')}</p>
      ) : (
        <>
          <Tessere etichetta={t('tempi.tessere')}>
            {/* Il push -> live e' gia' nel titolo: sei tessere stanno su una riga, sette no. */}
            <Tessera etichetta={t('tempi.pezzo.ci')} {...tessera('ci', kpi.ci)} />
            <Tessera etichetta={t('tempi.pezzo.attese')} {...tessera('attese', kpi.attese)} />
            <Tessera etichetta={t('tempi.pezzo.build')} {...tessera('build', kpi.build)} />
            <Tessera etichetta={t('tempi.pezzo.deploy')} {...tessera('deploy', kpi.deploy)} />
            <Tessera
              etichetta={t('tempi.falliti')}
              valore={f ? `${Math.round(f.tasso * 100)}%` : null}
              livello={f && f.tasso >= 0.25 ? 'crit' : f && f.tasso > 0.1 ? 'warn' : null}
              sotto={f ? t('rilasci.dep.tempi.suFiniti', { n: f.n, tot: f.tot }) : null}
              trend={{ valori: serie.falliti, forma: 'barre', descrizione: t('tempi.trend', { cosa: t('tempi.falliti') }) }}
            />
            <Tessera
              etichetta={t('tempi.alGiorno')}
              valore={punti.length ? numero(kpi.alGiorno, lang) : null}
              trend={{ valori: serie.riusciti, forma: 'barre', descrizione: t('tempi.trend', { cosa: t('tempi.alGiorno') }) }}
            />
          </Tessere>

          <Card titolo={t('tempi.pila.titolo', { finestra })} nota={t('tempi.pila.nota')}>
            <Legenda voci={PEZZI.map((p) => ({ etichetta: t(`tempi.pezzo.${p.k}`), colore: COLORE[p.k] }))} />
            <GraficoEventi
              andamento={serie}
              serie={PEZZI.map((p) => ({ k: p.k, etichetta: t(`tempi.pezzo.${p.k}`), colore: COLORE[p.k], valori: pz[p.k].map(inMin) }))}
              lang={lang}
              t={t}
              aria={t('tempi.pila.titolo', { finestra })}
              formato={fmtMin}
              extra={(i) => [{ etichetta: t('tempi.riuscite'), valore: String(serie.riusciti[i] ?? 0) }]}
            />
          </Card>

          <div className="tp-griglia">
            <Card titolo={t(`tempi.banda.titolo.${campo}`)} nota={t('tempi.banda.nota')}>
              <GraficoBanda
                andamento={serie}
                p50={linea.p50.map(inMin)}
                p90={linea.p90.map(inMin)}
                lang={lang}
                aria={t(`tempi.banda.titolo.${campo}`)}
                formato={fmtMin}
                etichette={{ p50: t('tempi.mediana'), p90: 'p90', extra: (i) => [{ etichetta: t('tempi.riuscite'), valore: String(serie.riusciti[i] ?? 0) }] }}
              />
            </Card>
            <Card titolo={t('tempi.rilasci.titolo')} nota={t('tempi.rilasci.nota')}>
              <Legenda
                voci={[
                  { etichetta: t('tempi.riuscite'), colore: 'var(--ok)' },
                  { etichetta: t('tempi.fallite'), colore: 'var(--crit)' },
                ]}
              />
              <GraficoEventi
                andamento={serie}
                serie={[
                  { k: 'ok', etichetta: t('tempi.riuscite'), colore: 'var(--ok)', valori: serie.riusciti },
                  { k: 'ko', etichetta: t('tempi.fallite'), colore: 'var(--crit)', valori: serie.falliti },
                ]}
                lang={lang}
                t={t}
                aria={t('tempi.rilasci.titolo')}
                extra={() => []}
              />
            </Card>
          </div>

          {multipli.righe.length > 1 && (
            <Card titolo={t(`tempi.multipli.titolo.${campo}`)} nota={t('tempi.multipli.nota')}>
              <PiccoliMultipli
                serie={serie}
                righe={multipli.righe.map((r) => ({
                  k: r.k,
                  etichetta: `${r.servizio} · ${etichettaConto(r.account)}`,
                  valori: r.valori.map(inMin),
                  dominio: multipli.dominio.map(inMin),
                  colore: 'var(--chart-1)',
                  formato: fmtMin,
                }))}
                lang={lang}
                t={t}
                aria={t(`tempi.multipli.titolo.${campo}`)}
                ultimoTesto={t('tempi.multipli.ultimo')}
              />
              {multipli.altri > 0 && <p className="ui-note">{t('tempi.multipli.altri', { n: multipli.altri })}</p>}
            </Card>
          )}

          <Card titolo={t('tempi.tabella.titolo', { finestra })} nota={t('rilasci.dep.tempi.nota')}>
            <TabellaTempi righe={righe} t={t} />
          </Card>
        </>
      )}
    </div>
  )
}
