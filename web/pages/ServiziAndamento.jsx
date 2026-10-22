import { useEffect, useMemo, useRef, useState } from 'react'
import { Verdetto, Card, Lista, Tessere, Tessera, GraficoEventi, GraficoBanda, PiccoliMultipli, Legenda } from '../ui/index.js'
import { usePoll } from '../usePoll.js'
import { useSchermoPieno } from '../ui/useSchermoPieno.js'
import { asList, matchesAny } from '../filters.js'
import { numero, riduci, fasceLarghe } from '../grafici.js'
import { durata } from '../format.js'
import { serieInsieme, kpiAndamento, perServizioAndamento, righeAndamento, livelloErrori, unoSu } from '../../shared/serviziSerie.js'
import './rilasci.css'

// Vista ANDAMENTO della pagina Servizi: quanto rispondono i servizi web e quanti errori danno, nel
// tempo. Una dashboard nello stile di Grafana scritta per leggersi al volo, sorella della pagina Tempi:
// «di solito» e «nei momenti lenti» invece di mediana e p90, i titoli sono la domanda a cui il pannello
// risponde. Le serie per servizio arrivano da /api/servizi/andamento (metriche degli ALB, vedi
// server/andamentoServizi.js); le somme e i filtri si fanno qui (shared/serviziSerie.js), cosi'
// scegliere un servizio non ripaga CloudWatch.

const ORE = [24, 168, 720]
// Il ritmo della pagina segue la cache del server: rileggere prima non porta un punto nuovo.
const RITMO = { 24: 5 * 60_000, 168: 30 * 60_000, 720: 30 * 60_000 }
// Sopra le novanta colonne un grafico a colonne diventa un pettine (su un telefono, un pixel l'una):
// le fasce si sommano a gruppi finche' ci stanno.
const MAX_COLONNE = 90
// Il prezzo di GetMetricData, per dire in pagina quanto costa una lettura (vedi il conto nel server).
const DOLLARI_PER_METRICA = 0.01 / 1000

const locale = (lang) => (lang === 'it' ? 'it-IT' : 'en-GB')

// Il tempo di risposta in parole corte: millisecondi interi sotto il secondo, secondi con un decimale
// sopra. Un trattino quando non c'e'.
function tempo(v, lang) {
  if (v == null || !Number.isFinite(v)) return '-'
  if (v < 1000) return `${Math.round(v)} ms`
  return `${numero(v / 1000, lang, v < 10_000 ? 1 : 0)} s`
}

// Un conteggio: le cifre intere fino al milione (1.234.567 non si legge, 12.345 si'), poi la forma
// corta della lingua («1,2 Mln», «1.2m»).
function conta(n, lang) {
  if (n == null || !Number.isFinite(n)) return '-'
  if (n < 1_000_000) return Math.round(n).toLocaleString(locale(lang))
  return new Intl.NumberFormat(locale(lang), { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

// Una quota in percentuale, con due decimali quando e' sotto il millesimo (0,04%: con un decimale
// sarebbe 0%, cioe' «nessun errore», che e' falso).
const percento = (x, lang) => (x == null || !Number.isFinite(x) ? '-' : `${numero(x * 100, lang, x < 0.001 ? 2 : 1)}%`)

// Una cella della tabella: il numero grande, la spiegazione sotto. L'etichetta serve sul telefono,
// dove l'intestazione delle colonne non c'e'. Stessa forma di quella della pagina Tempi.
function Cella({ etichetta, valore, sotto, livello }) {
  return (
    <span className="rl-tempo">
      <small className="rl-tempo-et">{etichetta}</small>
      <b className={livello ? `ui-t-${livello}` : undefined}>{valore ?? '-'}</b>
      {sotto && <small className="ui-mute">{sotto}</small>}
    </span>
  )
}

function TabellaServizi({ righe, etichettaConto, t, lang }) {
  const col = (k) => t(`andamento.tab.${k}`)
  return (
    <Lista
      colonne={[col('servizio'), col('richieste'), col('errori'), col('solito'), col('lenti')]}
      griglia="minmax(120px,1.6fr) repeat(4, minmax(56px,1fr))"
      grigliaMobile="minmax(0,1fr) minmax(0,1fr)"
      vuoto={t('andamento.tab.vuoto')}
    >
      {righe.map((r) => (
        <div key={r.k} className="ui-row rl-tempi-riga">
          <span className="ui-name">
            {r.servizio}
            <small>{etichettaConto(r.account)}</small>
          </span>
          <Cella etichetta={col('richieste')} valore={conta(r.richieste, lang)} />
          <Cella
            etichetta={col('errori')}
            valore={r.tasso == null ? null : percento(r.tasso, lang)}
            sotto={r.errori ? t('andamento.suTot', { n: conta(r.errori, lang), tot: conta(r.richieste, lang) }) : null}
            livello={livelloErrori(r.tasso)}
          />
          <Cella etichetta={col('solito')} valore={tempo(r.p50, lang)} />
          <Cella etichetta={col('lenti')} valore={tempo(r.p90, lang)} />
        </div>
      ))}
    </Lista>
  )
}

// `extra` e' il selettore della vista (Lista, Card, Andamento) della pagina Servizi: sta accanto al
// verdetto, come nelle altre due viste.
export default function ServiziAndamento({ t = (k) => k, lang, refreshKey, accountFilter = [], extra }) {
  const [ore, setOre] = useState(24)
  const [scelto, setScelto] = useState('')
  useSchermoPieno()
  // L'ambiente scelto in alto va al server: restringe PRIMA del tetto dei servizi letti.
  const conti = asList(accountFilter)
  const url = `/api/servizi/andamento?ore=${ore}&lang=${lang}${conti.length ? `&account=${encodeURIComponent(conti.join(','))}` : ''}`
  const { data, loading, error, refresh } = usePoll(url, { intervalMs: RITMO[ore] })

  const seenRk = useRef(refreshKey)
  useEffect(() => {
    if (refreshKey !== seenRk.current) {
      seenRk.current = refreshKey
      refresh()
    }
  }, [refreshKey, refresh])

  const ms = (v) => tempo(v, lang)
  const n = (v) => conta(v, lang)
  const etichettaConto = (k) => data?.account?.[k]?.label ?? k
  const tutti = useMemo(() => (data?.servizi ?? []).filter((s) => matchesAny(s.account, accountFilter)), [data, accountFilter])
  const elenco = useMemo(() => [...new Set(tutti.map((s) => s.servizio))].sort(), [tutti])
  // Un servizio scelto che l'ambiente in alto ha tolto non resta appeso: si torna a tutti.
  const attivo = elenco.includes(scelto) ? scelto : ''
  const servizi = useMemo(() => (attivo ? tutti.filter((s) => s.servizio === attivo) : tutti), [tutti, attivo])
  const punti = data?.punti ?? 0
  const serie = useMemo(() => serieInsieme(servizi, punti), [servizi, punti])
  const kpi = useMemo(() => kpiAndamento(servizi), [servizi])
  const multipli = useMemo(() => perServizioAndamento(servizi), [servizi])
  const righe = useMemo(() => righeAndamento(servizi), [servizi])
  const griglia = data ? { inizio: data.inizio, passoMs: data.passoMs, punti } : null
  // Le colonne degli errori a gruppi, contati dalla fine come fa `riduci`: l'ultima finisce adesso.
  const gruppo = Math.max(1, Math.ceil(punti / MAX_COLONNE))
  const colonne = griglia ? fasceLarghe(griglia, gruppo) : null
  const erroriC = useMemo(() => riduci(serie.errori, gruppo, 'somma'), [serie, gruppo])
  const richiesteC = useMemo(() => riduci(serie.richieste, gruppo, 'somma'), [serie, gruppo])

  const finestra = t(`andamento.finestra.${ore}`)
  const attesa = loading && !data
  const quanti = unoSu(kpi.errori, kpi.richieste)
  const resto = attesa
    ? t('andamento.v.attesa')
    : !servizi.length
      ? t('andamento.v.vuoto')
      : kpi.p50 == null
        ? t('andamento.v.senzaTraffico')
        : quanti === 0
          ? t('andamento.v.nessunErrore')
          : kpi.tasso >= 0.1
            ? t('andamento.v.quota', { pct: percento(kpi.tasso, lang) })
            : t('andamento.v.unoSu', { n: n(quanti) })
  const forte = attesa || kpi.p50 == null ? null : t(attivo ? 'andamento.v.forteUno' : 'andamento.v.forte', { s: attivo, ms: ms(kpi.p50) })
  const b = data?.bersagli
  const minutiCache = Math.round(RITMO[ore] / 60_000)
  const coloreFascia = 'color-mix(in srgb, var(--chart-1) 30%, transparent)'

  return (
    <div className="rl-pagina tp-pagina">
      <Verdetto
        livello={null}
        forte={forte}
        resto={resto}
        dettaglio={servizi.length && !attesa ? t('andamento.v.dettaglio', { finestra, n: servizi.length, richieste: n(kpi.richieste) }) : null}
        extra={extra}
      />

      {error && <div className="ui-readwarn">{error}</div>}
      {Object.entries(data?.account ?? {})
        .filter(([k, a]) => a.error && matchesAny(k, accountFilter))
        .map(([k, a]) => (
          <div key={k} className="ui-readwarn">
            {t('rilasci.nonLeggibile', { conto: a.label ?? k, errore: a.error })}
          </div>
        ))}
      {b && b.trovati > b.mostrati && <p className="ui-note">{t('andamento.tetto', { n: b.mostrati, tot: b.trovati })}</p>}

      {/* I filtri in una riga sola, sopra a tutti i grafici: valgono per tutta la vista. L'ambiente e'
          quello della barra in alto, come nelle altre viste. */}
      <div className="rl-tools">
        <div className="ui-seg" role="group" aria-label={t('andamento.finestraScelta')}>
          {ORE.map((o) => (
            <button key={o} type="button" aria-pressed={ore === o} onClick={() => setOre(o)}>
              {t(`andamento.finestraBreve.${o}`)}
            </button>
          ))}
        </div>
        <select className="tp-select" aria-label={t('andamento.servizio')} value={attivo} onChange={(e) => setScelto(e.target.value)}>
          <option value="">{t('andamento.tuttiServizi')}</option>
          {elenco.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {attesa ? null : (
        <>
          <Tessere etichetta={t('andamento.tessere')}>
            <Tessera
              etichetta={t('andamento.richieste')}
              valore={servizi.length ? n(kpi.richieste) : null}
              sotto={kpi.richieste ? t('andamento.alMinuto', { n: n(kpi.richieste / (ore * 60)) }) : null}
              trend={{ valori: serie.richieste, forma: 'barre', descrizione: t('andamento.trend', { cosa: t('andamento.richieste') }) }}
            />
            <Tessera
              etichetta={t('andamento.errori')}
              valore={kpi.tasso == null ? null : percento(kpi.tasso, lang)}
              livello={livelloErrori(kpi.tasso)}
              sotto={kpi.richieste ? t('andamento.suTot', { n: n(kpi.errori), tot: n(kpi.richieste) }) : null}
              trend={{ valori: serie.errori, forma: 'barre', descrizione: t('andamento.trend', { cosa: t('andamento.errori') }) }}
            />
            {/* Nelle tessere l'andamento senza le fasce vuote: e' una direzione in 90 pixel, non un
                asse del tempo, e coi buchi una serie rada sparisce. */}
            <Tessera
              etichetta={t('andamento.solito')}
              valore={kpi.p50 == null ? null : ms(kpi.p50)}
              trend={{ valori: serie.p50.filter((v) => v != null), descrizione: t('andamento.trend', { cosa: t('andamento.solito') }) }}
            />
            <Tessera
              etichetta={t('andamento.lenti')}
              valore={kpi.p90 == null ? null : ms(kpi.p90)}
              sotto={kpi.p90 == null ? null : t('andamento.lentiSotto')}
              trend={{ valori: serie.p90.filter((v) => v != null), descrizione: t('andamento.trend', { cosa: t('andamento.lenti') }) }}
            />
          </Tessere>

          {griglia && servizi.length > 0 && (
            <Card titolo={t('andamento.veloci.titolo')} nota={t('andamento.veloci.nota')}>
              <Legenda
                voci={[
                  { etichetta: t('andamento.legenda.solito'), colore: 'var(--chart-1)', forma: 'linea' },
                  { etichetta: t('andamento.legenda.lenti'), colore: coloreFascia },
                ]}
              />
              <GraficoBanda
                andamento={griglia}
                linea={serie.p50}
                alto={serie.p90}
                lang={lang}
                t={t}
                aria={t('andamento.veloci.titolo')}
                formato={ms}
                etichette={{ linea: t('andamento.legenda.solito'), alto: t('andamento.legenda.lenti') }}
                extra={(i) => [{ etichetta: t('andamento.richieste'), valore: n(serie.richieste[i]) }]}
              />
            </Card>
          )}

          {colonne && servizi.length > 0 && (
            <Card titolo={t('andamento.errori.titolo')} nota={t('andamento.errori.nota', { passo: durata(colonne.passoMs, t) })}>
              <GraficoEventi
                andamento={colonne}
                serie={[{ k: 'errori', etichetta: t('andamento.errori'), colore: 'var(--crit)', valori: erroriC }]}
                lang={lang}
                t={t}
                aria={t('andamento.errori.titolo')}
                formato={(v) => (Number.isInteger(v) ? n(v) : '')}
                extra={(i) => [
                  { etichetta: t('andamento.richieste'), valore: n(richiesteC[i]) },
                  { etichetta: t('andamento.errori.quota'), valore: richiesteC[i] ? percento(erroriC[i] / richiesteC[i], lang) : '-' },
                ]}
              />
              {kpi.errori === 0 && <p className="ui-note">{t('andamento.errori.nessuno')}</p>}
            </Card>
          )}

          {griglia && multipli.righe.length > 1 && (
            <Card titolo={t('andamento.multipli.titolo')} nota={t('andamento.multipli.nota')}>
              <PiccoliMultipli
                serie={griglia}
                righe={multipli.righe.map((r) => ({
                  k: r.k,
                  etichetta: `${r.servizio} · ${etichettaConto(r.account)}`,
                  valori: r.valori,
                  dominio: multipli.dominio,
                  colore: 'var(--chart-1)',
                  ponti: true,
                  formato: ms,
                }))}
                lang={lang}
                t={t}
                aria={t('andamento.multipli.titolo')}
                ultimoTesto={t('andamento.multipli.ultimo')}
              />
              {multipli.altri > 0 && <p className="ui-note">{t('andamento.multipli.altri', { n: multipli.altri })}</p>}
            </Card>
          )}

          <Card titolo={t('andamento.tabella.titolo')} nota={t('andamento.tabella.nota')}>
            <TabellaServizi righe={righe} etichettaConto={etichettaConto} t={t} lang={lang} />
          </Card>

          {data?.metriche > 0 && (
            <p className="ui-note">
              {t('andamento.fonte', { n: data.metriche, costo: numero(data.metriche * DOLLARI_PER_METRICA, lang, 4), min: minutiCache })}
            </p>
          )}
        </>
      )}
    </div>
  )
}
