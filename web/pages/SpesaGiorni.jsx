import { useEffect, useMemo, useState } from 'react'
import { Card, Lista, Tessere, Tessera, GraficoEventi, PiccoliMultipli, Legenda } from '../ui/index.js'
import { etichettaFascia, numero } from '../grafici.js'
import { soldi, leggi } from './spesaKit.js'
import {
  unisciConti,
  ultimi,
  soloServizi,
  grigliaGiorni,
  mezzanotte,
  coloriServizi,
  seriePila,
  kpiSpesa,
  tabellaServizi,
  multipliSpesa,
  classifica,
  totaliGiorno,
  COLORE_ALTRI,
} from '../../shared/spesaSerie.js'
// Le celle della tabella (numero grande, spiegazione sotto) sono quelle della tabella dei Tempi.
import { useSchermoPieno } from '../ui/useSchermoPieno.js'
import './rilasci.css'

// La spesa GIORNO PER GIORNO (Spesa, scheda Andamento): una dashboard nello stile di quella dei Tempi,
// scritta per leggersi al volo. «Di solito» invece di mediana, soldi scritti come nel resto della
// pagina, titoli che sono la domanda a cui il pannello risponde. Il server manda per account un valore
// al giorno per servizio (/api/costs/daily, una chiamata a Cost Explorer per account e finestra, sei
// ore di cache); le serie le fa shared/spesaSerie.js qui nel browser, cosi' scegliere un servizio o un
// account non costa una chiamata.
//
// Cosa si misura: in cima il NETTO, dopo crediti e tasse, come il verdetto della pagina: e' quello che
// si paga. Grafico per servizio, piccoli multipli e tabella invece sono a LISTINO, perche' e' l'unico
// che si divide per servizio (un credito e' una riga del conto, non di un servizio), e lo dicono.

const FINESTRE = [30, 90]
const GIORNO = 86_400_000

// L'asse dei valori ha 28 pixel a sinistra: «1.000 $» non ci sta, «1k» si'. Il simbolo lo dice il titolo.
const soldiAsse = (v, lang) => (v >= 1000 ? `${numero(v / 1000, lang)}k` : numero(v, lang, v < 10 ? 1 : 0))

// Una settimana che costa un quarto in piu' di quella prima si guarda; sotto i 7 $ (un dollaro al giorno)
// no, perche' su importi cosi' piccoli un +25% e' il rumore di un giorno.
const SALE_TROPPO = 0.25
const SETTIMANA_MINIMA = 7

// Una cella della tabella: il numero grande, la spiegazione sotto. L'etichetta serve sul telefono, dove
// l'intestazione delle colonne non c'e'. Stesse classi della tabella dei Tempi.
function Cella({ etichetta, valore, sotto, livello }) {
  return (
    <span className="rl-tempo">
      <small className="rl-tempo-et">{etichetta}</small>
      <b className={livello ? `ui-t-${livello}` : undefined}>{valore ?? '-'}</b>
      {sotto && <small className="ui-mute">{sotto}</small>}
    </span>
  )
}

// «su del 12%», «giù del 5%», «uguale»: la direzione a parole, non una freccia colorata da decifrare.
function variazione(s, t) {
  if (s.variazione == null) return s.nuovo ? t('spesa.g.nuovo') : null
  const p = Math.round(Math.abs(s.variazione) * 100)
  if (p === 0) return t('spesa.g.pari')
  return t(s.variazione > 0 ? 'spesa.g.su' : 'spesa.g.giu', { p })
}

function TabellaSpesa({ righe, finestra, t, lang }) {
  const col = (k) => t(`spesa.g.tab.${k}`)
  return (
    <Lista
      colonne={[col('servizio'), col('totale'), col('solito'), col('settimana'), col('quota')]}
      griglia="minmax(0,1.6fr) repeat(4, minmax(90px,1fr))"
      grigliaMobile="minmax(0,1fr) minmax(0,1fr)"
      vuoto={t('spesa.g.vuoto')}
    >
      {righe.map((r) => {
        const s = r.settimana
        const sale = s.variazione != null && s.variazione >= SALE_TROPPO && s.ultimi >= SETTIMANA_MINIMA
        return (
          <div key={r.servizio} className="ui-row sp-g-riga">
            <span className="ui-name">
              {r.servizio}
              {r.ai && <small>{t('costs.aiMark')}</small>}
            </span>
            <Cella etichetta={col('totale')} valore={soldi(r.totale, lang)} sotto={finestra} />
            <Cella etichetta={col('solito')} valore={soldi(r.solito, lang)} />
            <Cella
              etichetta={col('settimana')}
              valore={variazione(s, t)}
              sotto={s.prima != null ? t('spesa.g.contro', { a: soldi(s.ultimi, lang), b: soldi(s.prima, lang) }) : null}
              livello={sale ? 'warn' : null}
            />
            <Cella etichetta={col('quota')} valore={r.quota != null ? `${numero(r.quota * 100, lang, 1)}%` : null} />
          </div>
        )
      })}
    </Lista>
  )
}

export default function SpesaGiorni({ accountLabels, type = 'all', t = (k) => k, lang }) {
  const [giorni, setGiorni] = useState(30)
  const [servizio, setServizio] = useState('')
  useSchermoPieno()
  const [risposta, setRisposta] = useState(null)

  // Una chiamata per finestra e Livello: account e servizio si filtrano qui, gratis.
  useEffect(() => {
    let vivo = true
    setRisposta(null)
    leggi(`/api/costs/daily?giorni=${giorni}&type=${encodeURIComponent(type)}&lang=${lang}`).then((r) => vivo && setRisposta(r))
    return () => {
      vivo = false
    }
  }, [giorni, type, lang])

  const visibile = (acc) => !accountLabels || accountLabels.has(acc?.label)
  const conti = Object.values(risposta?.dati ?? {})
  const leggibili = useMemo(() => conti.filter((a) => !a.error), [risposta])
  const visibili = useMemo(() => leggibili.filter(visibile), [leggibili, accountLabels])
  const errori = conti.filter((a) => a.error && visibile(a))

  // I colori dai dati di TUTTI gli account: cambiare account non ridipinge le colonne.
  const colori = useMemo(() => coloriServizi(ultimi(unisciConti(leggibili), giorni)), [leggibili, giorni])
  const uniti = useMemo(() => unisciConti(visibili), [visibili])
  const nellaFinestra = useMemo(() => classifica(ultimi(uniti, giorni)), [uniti, giorni])
  const elenco = useMemo(() => nellaFinestra.map((s) => s.servizio).sort((a, b) => a.localeCompare(b)), [nellaFinestra])
  // Un servizio scelto che con questi account non c'e' non filtra a vuoto: si torna a tutti.
  const scelti = servizio && elenco.includes(servizio) ? [servizio] : []

  const tutto = useMemo(() => soloServizi(uniti, scelti), [uniti, scelti[0]])
  const fin = useMemo(() => ultimi(tutto, giorni), [tutto, giorni])
  const g = useMemo(() => grigliaGiorni(fin.giorni), [fin])
  const pezzi = useMemo(() => seriePila(fin, colori), [fin, colori])
  const totali = useMemo(() => totaliGiorno(fin), [fin])
  const kpi = useMemo(() => kpiSpesa(tutto, giorni), [tutto, giorni])
  const base = nellaFinestra.reduce((s, r) => s + r.totale, 0)
  const righe = useMemo(() => tabellaServizi(fin, { base }), [fin, base])
  const multipli = useMemo(() => multipliSpesa(fin, { max: 10 }), [fin])

  const finestra = t(`spesa.g.finestra.${giorni}`)
  const S = (v) => soldi(v, lang)
  const giornoDi = (gg) => etichettaFascia(mezzanotte(gg), GIORNO, lang)
  const titolo = (i) => `${giornoDi(fin.giorni[i])}${fin.giorni[i] === fin.oggi ? ` · ${t('spesa.g.oggiParziale')}` : ''}`
  const etichetta = (p) => p.servizio ?? t('spesa.g.altri', { n: p.quanti })
  const { mese, proiezione: pr, alGiorno, piuCaro } = kpi
  const pronta = risposta?.dati && visibili.length > 0

  const testa = !risposta ? (
    <p className="ui-mute">{t('spend.carico')}</p>
  ) : risposta.errore ? (
    <div className="ui-readwarn">{risposta.errore}</div>
  ) : !visibili.length ? (
    <p className="ui-vuoto">{conti.length ? t('costs.allFiltered') : t('costs.noAccounts')}</p>
  ) : mese ? (
    <div className="sp-g-testa">
      <h2>
        <b>{t('spesa.g.v.forte', { v: S(mese.netto) })}</b>
        {pr ? t('spesa.g.v.resto', { p: S(pr.net) }) : null}
      </h2>
      <p className="ui-mute">
        {scelti.length ? t('spesa.g.v.servizio', { s: scelti[0] }) : mese.conCrediti ? t('spesa.g.v.dettaglio', { v: S(mese.lordo) }) : t('spesa.g.v.senzaCrediti')}
      </p>
    </div>
  ) : (
    <p className="ui-vuoto">{t('spesa.g.v.vuoto', { finestra })}</p>
  )

  return (
    <div className="sp-col sp-giorni">
      {testa}
      {errori.map((a) => (
        <div key={a.label} className="ui-readwarn">
          {t('spesa.g.nonLeggibile', { conto: a.label, errore: a.error })}
        </div>
      ))}

      {/* I filtri in una riga sola, sopra a tutti i grafici: valgono per tutta la dashboard. L'account
          e il Livello sono quelli della barra in alto e della riga sopra. */}
      <div className="sp-g-filtri">
        <div className="ui-seg" role="group" aria-label={t('spesa.g.finestraEt')}>
          {FINESTRE.map((n) => (
            <button key={n} type="button" aria-pressed={giorni === n} onClick={() => setGiorni(n)}>
              {t(`spesa.g.finestraBreve.${n}`)}
            </button>
          ))}
        </div>
        <select className="sp-g-select" aria-label={t('spesa.g.servizio')} value={scelti[0] ?? ''} onChange={(e) => setServizio(e.target.value)}>
          <option value="">{t('spesa.g.tuttiServizi')}</option>
          {elenco.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {pronta && (
        <>
          <Tessere etichetta={t('spesa.g.tessere')}>
            <Tessera
              etichetta={t('spesa.g.mese')}
              valore={mese ? S(mese.netto) : null}
              sotto={mese ? t('spesa.g.listino', { v: S(mese.lordo) }) : null}
              title={mese ? t('spesa.g.suGiorni', { n: mese.giorni }) : undefined}
              trend={mese ? { valori: mese.cumulato, descrizione: t('spesa.g.trend', { cosa: t('spesa.g.mese') }) } : null}
            />
            <Tessera
              etichetta={t('spesa.g.proiezione')}
              valore={pr ? S(pr.net) : null}
              sotto={pr ? t('spesa.g.listino', { v: S(pr.gross) }) : null}
              // La base della stima nel tooltip: a inizio mese pochi giorni fanno una stima rumorosa.
              title={pr ? (pr.chiuso ? t('spesa.g.meseChiuso') : t('spesa.g.base', { d: pr.daysElapsed, tot: pr.daysInMonth })) : undefined}
              trend={pr ? { valori: pr.andamento, descrizione: t('spesa.g.trend', { cosa: t('spesa.g.proiezione') }) } : null}
            />
            <Tessera
              etichetta={t('spesa.g.alGiorno')}
              valore={alGiorno ? S(alGiorno.valore) : null}
              sotto={alGiorno ? t('spesa.g.giorniInteri', { n: alGiorno.andamento.length }) : null}
              trend={alGiorno ? { valori: alGiorno.andamento, descrizione: t('spesa.g.trend', { cosa: t('spesa.g.alGiorno') }) } : null}
            />
            <Tessera
              etichetta={t('spesa.g.piuCaro')}
              valore={piuCaro ? S(piuCaro.valore) : null}
              sotto={piuCaro ? giornoDi(piuCaro.giorno) : null}
              trend={piuCaro ? { valori: piuCaro.andamento, forma: 'barre', descrizione: t('spesa.g.trend', { cosa: t('spesa.g.piuCaro') }) } : null}
            />
          </Tessere>

          <Card titolo={t('spesa.g.pila.titolo')} nota={t('spesa.g.pila.nota')}>
            {/* La legenda sempre, anche con una fetta sola: dice di chi e' il colore. */}
            <Legenda voci={pezzi.map((p) => ({ etichetta: etichetta(p), colore: p.colore }))} />
            <GraficoEventi
              andamento={g}
              serie={pezzi.map((p) => ({ k: p.k, etichetta: etichetta(p), colore: p.colore, valori: p.valori }))}
              lang={lang}
              t={t}
              aria={t('spesa.g.pila.titolo')}
              formato={S}
              formatoAsse={(v) => soldiAsse(v, lang)}
              titolo={titolo}
              extra={(i) => [{ etichetta: t('spesa.g.totale'), valore: S(totali[i]) }]}
            />
          </Card>

          {multipli.righe.length > 1 && (
            <Card titolo={t('spesa.g.multipli.titolo')} nota={t('spesa.g.multipli.nota')}>
              <PiccoliMultipli
                serie={g}
                righe={multipli.righe.map((r) => ({
                  k: r.servizio,
                  etichetta: r.servizio,
                  valori: r.valori,
                  dominio: multipli.dominio,
                  // Lo stesso colore delle colonne: chi ha un colore suo lo tiene, gli altri sono «Altri».
                  colore: colori.get(r.servizio) ?? COLORE_ALTRI,
                  ponti: true,
                  formato: S,
                }))}
                lang={lang}
                t={t}
                aria={t('spesa.g.multipli.titolo')}
                ultimoTesto={t('spesa.g.multipli.ultimo')}
                titolo={titolo}
              />
              {multipli.altri > 0 && <p className="ui-note">{t('spesa.g.multipli.altri', { n: multipli.altri })}</p>}
            </Card>
          )}

          <Card titolo={t('spesa.g.tabella.titolo')} nota={t('spesa.g.tabella.nota')}>
            <TabellaSpesa righe={righe} finestra={finestra} t={t} lang={lang} />
          </Card>
        </>
      )}
    </div>
  )
}
