import { useEffect, useMemo, useRef, useState } from 'react'
import { Verdetto, Card, Lista, Pill, Tessere, Tessera, GraficoEventi, PiccoliMultipli, Legenda } from '../ui/index.js'
import { usePoll } from '../usePoll.js'
import { useSchermoPieno } from '../ui/useSchermoPieno.js'
import { matchesAny, listaDaUrl } from '../filters.js'
import { numero } from '../grafici.js'
import { durata } from '../format.js'
import { PEZZI, griglia, serieTempi, kpiTempi, perServizio } from '../../shared/tempiSerie.js'
import './rilasci.css'

// Vista ANDAMENTO della pagina Deploy: quanto ci mette un rilascio e dove perde tempo, nel tempo. Una dashboard nello stile
// di Grafana, scritta per leggersi al volo: «di solito» e «nei giorni lenti» invece di mediana e p90,
// durate arrotondate al minuto, titoli che sono la domanda a cui il pannello risponde. I punti (uno per
// build) arrivano da /api/deploys/storico; le serie le fa shared/tempiSerie.js qui nel browser, cosi'
// cambiare servizio o ambiente non rifa' il giro di CodeBuild e GitHub.
//
// Cosa si misura: dal push a in produzione quando i run di GitHub ci sono, altrimenti dall'avvio della
// build. Non e' una scelta di chi legge: un selettore fra le due chiedeva di sapere la differenza.

const GIORNI = [7, 30, 90]
// Il colore segue il pezzo, in ordine fisso: CI, attese (grigio: tempo in cui non lavora nessuno),
// build, deploy. Sono i quattro colori dei grafici di app.css, gia' validati per chiaro e scuro.
const COLORE = { ci: 'var(--chart-1)', attese: 'var(--chart-neutro)', build: 'var(--chart-2)', deploy: 'var(--chart-3)' }
// Le fasi della tabella, nell'ordine in cui succedono: per la colonna «dove perde piu' tempo».
const FASI = ['ci', 'attesa', 'coda', 'build', 'deploy']

// I grafici lavorano in MINUTI: l'asse tondo (1, 2, 5, 10) cade su minuti tondi.
const inMin = (v) => (v == null ? null : v / 60_000)

// Una cella della tabella: il numero grande, la spiegazione sotto. L'etichetta serve sul telefono,
// dove l'intestazione delle colonne non c'e'.
function Cella({ etichetta, valore, sotto, livello }) {
  return (
    <span className="rl-tempo">
      <small className="rl-tempo-et">{etichetta}</small>
      <b className={livello ? `ui-t-${livello}` : undefined}>{valore ?? '-'}</b>
      {sotto && <small className="ui-mute">{sotto}</small>}
    </span>
  )
}

function TabellaTempi({ righe, t, d }) {
  const col = (k) => t(`tempi.tab.${k}`)
  return (
    <Lista
      colonne={[col('servizio'), col('solito'), col('lenti'), col('fase'), col('falliti'), col('settimana'), col('verde'), col('daStaging')]}
      griglia="minmax(120px,1.4fr) repeat(7, minmax(56px,1fr))"
      grigliaMobile="minmax(0,1fr) minmax(0,1fr)"
      vuoto={t('rilasci.dep.tempi.vuoto')}
    >
      {righe.map((r) => {
        const f = r.fallimento
        const misura = r.lead ?? r.totale
        const fase = FASI.filter((k) => r[k]).sort((a, b) => r[b].p50 - r[a].p50)[0]
        return (
          <div key={`${r.account}/${r.servizio}`} className="ui-row rl-tempi-riga">
            <span className="ui-name">
              {r.servizio}
              <small>{r.accountLabel}</small>
              {r.lenta && (
                <span title={t('tempi.lentaTip', { d: d(r.lenta.durationMs), solito: d(r.lenta.p50) })}>
                  <Pill livello="warn">{t('rilasci.dep.tempi.lenta')}</Pill>
                </span>
              )}
            </span>
            <Cella etichetta={col('solito')} valore={misura ? d(misura.p50) : null} sotto={misura ? t(r.lead ? 'tempi.dalPush' : 'tempi.dallaBuild') : null} />
            <Cella etichetta={col('lenti')} valore={misura ? d(misura.p90) : null} />
            <Cella etichetta={col('fase')} valore={fase ? t(`tempi.fase.${fase}`) : null} sotto={fase ? d(r[fase].p50) : null} />
            <Cella
              etichetta={col('falliti')}
              valore={f ? `${Math.round(f.tasso * 100)}%` : null}
              sotto={f ? t('rilasci.dep.tempi.suFiniti', { n: f.falliti, tot: f.finiti }) : null}
              livello={f && f.tasso >= 0.25 ? 'crit' : f && f.tasso > 0.1 ? 'warn' : null}
            />
            <Cella etichetta={col('settimana')} valore={r.settimana ? String(r.settimana.n) : null} />
            <Cella etichetta={col('verde')} valore={r.ripristino ? d(r.ripristino.p50) : null} sotto={r.ripristino ? t('tempi.volte', { n: r.ripristino.n }) : null} />
            {/* Solo in produzione, e solo dove lo stesso commit e' uscito anche in staging: un merge commit
                ha un altro sha, e li' si dice che l'abbinamento non c'e' invece di inventarlo. */}
            <Cella
              etichetta={col('daStaging')}
              valore={r.daStaging ? d(r.daStaging.p50) : null}
              sotto={r.daStaging ? t('tempi.daStagingSotto', { n: r.daStaging.n }) : r.ambiente === 'produzione' ? t('tempi.nonAbbinato') : null}
            />
          </div>
        )
      })}
    </Lista>
  )
}

export default function TempiPage({ t = (k) => k, lang, refreshKey, accountFilter = [] }) {
  // Sette giorni e non trenta: la vista apre su quello che c'e' da sapere adesso, e a cache fredda un giro
  // a 30 giorni dura minuti (158 secondi misurati il 20/10/2026), uno a 7 una frazione.
  const [giorni, setGiorni] = useState(7)
  useSchermoPieno()
  // Deep-link `?service=a,b`, come la pagina Deploy.
  const [servizi, setServizi] = useState(() => (typeof window === 'undefined' ? [] : listaDaUrl(window.location.search, 'service')))
  const { data, loading, error, refresh } = usePoll(`/api/deploys/storico?giorni=${giorni}&lang=${lang}`, { intervalMs: 600000 })

  const seenRk = useRef(refreshKey)
  useEffect(() => {
    if (refreshKey !== seenRk.current) {
      seenRk.current = refreshKey
      refresh()
    }
  }, [refreshKey, refresh])

  const d = (ms) => durata(ms, t)
  const dMin = (v) => (v == null ? '-' : v === 0 ? '0' : d(v * 60_000))
  const etichettaConto = (k) => data?.account?.[k]?.label ?? k
  const tutti = useMemo(() => (data?.punti ?? []).filter((p) => matchesAny(p.a, accountFilter)), [data, accountFilter])
  const elencoServizi = useMemo(() => [...new Set(tutti.map((p) => p.s))].sort(), [tutti])
  const punti = useMemo(() => tutti.filter((p) => matchesAny(p.s, servizi)), [tutti, servizi])
  const righe = useMemo(() => (data?.righe ?? []).filter((r) => matchesAny(r.account, accountFilter) && matchesAny(r.servizio, servizi)), [data, accountFilter, servizi])

  const g = useMemo(() => griglia({ giorni }), [giorni, data])
  const serie = useMemo(() => serieTempi(punti, g), [punti, g])
  const kpi = useMemo(() => kpiTempi(punti, { giorni }), [punti, giorni])
  const campo = punti.some((p) => p.lead != null) ? 'lead' : 'totale'
  const multipli = useMemo(() => perServizio(punti, g, { campo }), [punti, g, campo])
  const linea = campo === 'lead' ? serie.lead : serie.totale
  const testa = kpi[campo]

  const finestra = t(`tempi.finestra.${giorni}`)
  const pz = Object.fromEntries(serie.pezzi.map((p) => [p.k, p.valori]))
  // Nelle tessere l'andamento senza le fasce vuote: e' una direzione in 90 pixel, non un asse del tempo,
  // e coi buchi una serie rada sparisce.
  const tessera = (k, r) => ({
    valore: r ? d(r.p50) : null,
    sotto: r ? t('tempi.lentiBreve', { d: d(r.p90) }) : null,
    trend: { valori: (pz[k] ?? []).filter((v) => v != null), descrizione: t('tempi.trend', { cosa: t(`tempi.pezzo.${k}`) }) },
  })
  const f = kpi.falliti
  const riuscite = (i) => [{ etichetta: t('tempi.riuscite'), valore: String(serie.riusciti[i] ?? 0) }]

  return (
    <div className="rl-pagina tp-pagina">
      <Verdetto
        livello={null}
        forte={loading && !data ? null : testa ? t('tempi.v.forte', { d: d(testa.p50) }) : null}
        resto={loading && !data ? t('rilasci.dep.v.attesa') : testa ? t(`tempi.v.resto.${campo}`, { lenti: d(testa.p90) }) : t('tempi.v.vuoto', { finestra })}
        dettaglio={testa ? t('tempi.v.dettaglio', { finestra, n: testa.n }) : null}
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
      </div>

      {loading && !data ? (
        <p className="ui-mute">{t('rilasci.dep.v.attesa')}</p>
      ) : (
        <>
          <Tessere etichetta={t('tempi.tessere')}>
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

          <Card titolo={t('tempi.pila.titolo')} nota={t('tempi.pila.nota')}>
            <Legenda voci={PEZZI.map((p) => ({ etichetta: t(`tempi.pezzo.${p.k}`), colore: COLORE[p.k] }))} />
            <GraficoEventi
              andamento={serie}
              serie={PEZZI.map((p) => ({ k: p.k, etichetta: t(`tempi.pezzo.${p.k}`), colore: COLORE[p.k], valori: pz[p.k].map(inMin) }))}
              lang={lang}
              t={t}
              aria={t('tempi.pila.titolo')}
              formato={dMin}
              extra={(i) => [
                { etichetta: t('tempi.totaleSolito'), valore: dMin(inMin(linea.p50[i])) },
                { etichetta: t('tempi.totaleLenti'), valore: dMin(inMin(linea.p90[i])) },
                ...riuscite(i),
              ]}
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

          {multipli.righe.length > 1 && (
            <Card titolo={t('tempi.multipli.titolo')} nota={t(`tempi.multipli.nota.${campo}`)}>
              <PiccoliMultipli
                serie={serie}
                righe={multipli.righe.map((r) => ({
                  k: r.k,
                  etichetta: `${r.servizio} · ${etichettaConto(r.account)}`,
                  valori: r.valori.map(inMin),
                  dominio: multipli.dominio.map(inMin),
                  colore: 'var(--chart-1)',
                  ponti: true,
                  formato: dMin,
                }))}
                lang={lang}
                t={t}
                aria={t('tempi.multipli.titolo')}
                ultimoTesto={t('tempi.multipli.ultimo')}
              />
              {multipli.altri > 0 && <p className="ui-note">{t('tempi.multipli.altri', { n: multipli.altri })}</p>}
            </Card>
          )}

          <Card titolo={t('tempi.tabella.titolo')} nota={t('tempi.tabella.nota')}>
            <TabellaTempi righe={righe} t={t} d={d} />
          </Card>
        </>
      )}
    </div>
  )
}
