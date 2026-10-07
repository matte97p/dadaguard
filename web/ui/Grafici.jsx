import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { etichettaFascia, impila, percorso, percorsoBanda, tacche, tondo } from '../grafici.js'

// I GRAFICI DEL TEMPO del cruscotto: la memoria della flotta (Flotta), gli eventi della finestra
// (Accessi) e i piccoli multipli del pannello di un Mac. Tre forme, una meccanica sola: l'asse del
// tempo in basso, una scala sola per grafico, il mirino che segue il mouse (e le frecce da tastiera,
// col grafico a fuoco) e il riquadro coi valori di quell'istante.
//
// Si disegna in pixel veri (la larghezza la misura un ResizeObserver), non in un viewBox stirato: in
// un viewBox le linee sottili diventano spesse o sfocate, e il testo si allarga con il grafico.

// La larghezza del contenitore, aggiornata quando cambia. Parte da un valore plausibile, cosi' il
// primo disegno non e' largo zero.
function useLarghezza(iniziale = 640) {
  const ref = useRef(null)
  const [w, setW] = useState(iniziale)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    setW(el.clientWidth || iniziale)
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width) || iniziale))
    ro.observe(el)
    return () => ro.disconnect()
  }, [iniziale])
  return [ref, w]
}

// Il mirino: quale punto sta guardando chi legge. Col mouse il piu' vicino in orizzontale; con le
// frecce un punto alla volta (Home e Fine agli estremi), Esc lo toglie.
function useMirino(punti, xDi) {
  const [i, setI] = useState(null)
  const daX = useCallback(
    (px) => {
      if (!punti) return null
      let best = 0
      let dist = Infinity
      for (let k = 0; k < punti; k++) {
        const d = Math.abs(xDi(k) - px)
        if (d < dist) {
          dist = d
          best = k
        }
      }
      return best
    },
    [punti, xDi],
  )
  const props = {
    onPointerMove: (e) => {
      const r = e.currentTarget.getBoundingClientRect()
      setI(daX(e.clientX - r.left))
    },
    onPointerLeave: () => setI(null),
    onBlur: () => setI(null),
    onKeyDown: (e) => {
      if (e.key === 'ArrowRight') setI((x) => Math.min(punti - 1, x == null ? punti - 1 : x + 1))
      else if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x == null ? punti - 1 : x - 1))
      else if (e.key === 'Home') setI(0)
      else if (e.key === 'End') setI(punti - 1)
      else if (e.key === 'Escape') setI(null)
      else return
      e.preventDefault()
    },
  }
  return [i, props]
}

// Il riquadro dei valori: sopra al grafico, accanto al mirino, dentro i bordi.
function Lettura({ x, larghezza, titolo, righe }) {
  const ref = useRef(null)
  const [w, setW] = useState(180)
  useEffect(() => {
    if (ref.current) setW(ref.current.offsetWidth)
  })
  const sinistra = x + 12 + w > larghezza ? Math.max(0, x - 12 - w) : x + 12
  return (
    <div className="ui-lettura" ref={ref} style={{ left: sinistra }} role="status">
      <b>{titolo}</b>
      {righe.map((r) => (
        <span key={r.etichetta}>
          {r.colore ? <i style={{ background: r.colore }} /> : <i className="ui-lettura-vuoto" />}
          <span>{r.etichetta}</span>
          <em>{r.valore}</em>
        </span>
      ))}
    </div>
  )
}

// L'asse del tempo: le tacche in basso, e una griglia verticale appena accennata sulle tacche dei
// giorni (sulle altre no: dieci linee verticali sono una gabbia).
function AsseTempo({ serie, x, alto, basso, lang, griglia = true }) {
  const t = tacche(serie, lang)
  const passo = t.length > 1 ? x(t[1].i) - x(t[0].i) : Infinity
  // Le etichette si diradano quando non ci stanno: una ogni due, poi una ogni tre.
  const ogni = passo < 46 ? Math.ceil(46 / passo) : 1
  return (
    <g className="ui-asse">
      {t.map((k, n) => (
        <g key={k.t}>
          {griglia && <line x1={x(k.i)} x2={x(k.i)} y1={alto} y2={basso} className="ui-griglia-v" />}
          <line x1={x(k.i)} x2={x(k.i)} y1={basso} y2={basso + 4} className="ui-tacca" />
          {n % ogni === 0 && (
            <text x={x(k.i)} y={basso + 15} textAnchor={n === 0 && x(k.i) < 20 ? 'start' : 'middle'}>
              {k.label}
            </text>
          )}
        </g>
      ))}
    </g>
  )
}

// Le linee orizzontali dei valori (zero e il massimo tondo, e la meta'), con l'etichetta a sinistra.
function AsseValori({ dominio, y, sinistra, destra, formato }) {
  const [lo, hi] = dominio
  const valori = [lo, (lo + hi) / 2, hi]
  return (
    <g className="ui-asse">
      {valori.map((v, n) => (
        <g key={v}>
          <line x1={sinistra} x2={destra} y1={y(v)} y2={y(v)} className={n === 0 ? 'ui-base' : 'ui-griglia'} />
          <text x={sinistra - 6} y={y(v) + 4} textAnchor="end">
            {formato(v)}
          </text>
        </g>
      ))}
    </g>
  )
}

// La legenda: sempre presente con due serie o piu', sopra al grafico, col segno della serie accanto
// al nome (il testo resta nel colore del testo, non in quello della serie).
export function Legenda({ voci = [] }) {
  return (
    <div className="ui-legenda">
      {voci.map((v) => (
        <span key={v.etichetta} className={v.spenta ? 'ui-legenda-spenta' : undefined}>
          <i className={`ui-legenda-${v.forma ?? 'quadro'}`} style={{ '--c': v.colore }} />
          {v.etichetta}
          {v.valore != null && <b>{v.valore}</b>}
        </span>
      ))}
    </div>
  )
}

// ── Memoria della flotta ────────────────────────────────────────────────────────────────────────────
//
// Una settimana, un punto per ora: la fascia fra la memoria libera della VM PEGGIORE e quella del Mac
// TIPICO (la mediana), la linea del minimo nel colore d'accento e quella della mediana in grigio. Se
// la fascia e' larga il problema e' un Mac solo; se il minimo e la mediana scendono insieme e' la
// flotta. Sotto, sullo stesso asse, una riga con le ore in cui la memoria ha ucciso un processo.
export function GraficoMemoria({ andamento, lang, t, formatoGb }) {
  const [ref, larghezza] = useLarghezza()
  const { punti = 0, memMin = [], memMediana = [], memMinChi = [], oom = [], attivi = [] } = andamento ?? {}
  const m = { sx: 44, dx: 14, su: 10, plot: 150, striscia: 26, giu: 24 }
  const destra = Math.max(m.sx + 40, larghezza - m.dx)
  const x = useCallback((i) => m.sx + (i * (destra - m.sx)) / Math.max(1, punti - 1), [destra, punti, m.sx])
  const valori = [...memMin, ...memMediana].filter((v) => v != null)
  const hi = tondo(Math.max(1, ...valori))
  const y = (v) => m.su + m.plot - (v / hi) * m.plot
  const baseStriscia = m.su + m.plot + 10 + m.striscia
  const asse = baseStriscia
  const altezza = asse + m.giu
  const maxOom = Math.max(1, ...oom.filter((v) => v != null))
  const [i, mirino] = useMirino(punti, x)
  if (!punti) return null
  const ultimo = memMin.reduce((u, v, k) => (v != null ? k : u), -1)
  const banda = Math.max(2, (destra - m.sx) / punti)
  return (
    <div className="ui-grafico" ref={ref}>
      <svg
        width={larghezza}
        height={altezza}
        tabIndex={0}
        role="img"
        aria-label={t('flotta.grafico.aria')}
        {...mirino}
      >
        <AsseValori dominio={[0, hi]} y={y} sinistra={m.sx} destra={destra} formato={(v) => `${formatoGb(v)}`} />
        <AsseTempo serie={andamento} x={x} alto={m.su} basso={asse} lang={lang} />
        <path d={percorsoBanda(memMediana, memMin, x, y)} className="ui-banda" />
        <path d={percorso(memMediana, x, y)} className="ui-linea ui-linea-neutra" />
        <path d={percorso(memMin, x, y)} className="ui-linea ui-linea-accento" />
        {ultimo >= 0 && <circle cx={x(ultimo)} cy={y(memMin[ultimo])} r="4" className="ui-punto-accento" />}
        <text x={m.sx - 6} y={baseStriscia - 6} textAnchor="end" className="ui-asse-et">
          OOM
        </text>
        <line x1={m.sx} x2={destra} y1={baseStriscia + 0.5} y2={baseStriscia + 0.5} className="ui-base" />
        {oom.map((v, k) =>
          v > 0 ? (
            <rect
              key={k}
              x={x(k) - Math.min(6, banda) / 2}
              width={Math.min(6, banda)}
              y={baseStriscia - Math.max(6, (v / maxOom) * (m.striscia - 4))}
              height={Math.max(6, (v / maxOom) * (m.striscia - 4))}
              rx="1.5"
              className="ui-oom"
            />
          ) : null,
        )}
        {i != null && <line x1={x(i)} x2={x(i)} y1={m.su} y2={asse} className="ui-mirino" />}
        {i != null && memMin[i] != null && <circle cx={x(i)} cy={y(memMin[i])} r="4" className="ui-punto-accento" />}
        {i != null && memMediana[i] != null && <circle cx={x(i)} cy={y(memMediana[i])} r="4" className="ui-punto-neutro" />}
      </svg>
      {i != null && (
        <Lettura
          x={x(i)}
          larghezza={larghezza}
          titolo={etichettaFascia(andamento.inizio + i * andamento.passoMs, andamento.passoMs, lang)}
          righe={[
            { colore: 'var(--chart-1)', etichetta: t('flotta.grafico.minimo'), valore: memMin[i] == null ? '-' : `${formatoGb(memMin[i])} GB${memMinChi[i] ? ` · ${memMinChi[i]}` : ''}` },
            { colore: 'var(--chart-neutro)', etichetta: t('flotta.grafico.mediana'), valore: memMediana[i] == null ? '-' : `${formatoGb(memMediana[i])} GB` },
            { colore: 'var(--crit)', etichetta: t('flotta.grafico.oom'), valore: oom[i] == null ? '-' : String(oom[i]) },
            { etichetta: t('flotta.grafico.accesi'), valore: String(attivi[i] ?? '-') },
          ]}
        />
      )}
    </div>
  )
}

// ── Eventi della finestra ───────────────────────────────────────────────────────────────────────────
//
// Colonne impilate, una per fascia, coi tipi che contano (login fallite, accessi negati, scritture in
// produzione, SSH). Colonne sottili con l'aria fra l'una e l'altra, due pixel di fondo fra i pezzi
// della stessa colonna, l'angolo tondo solo in cima. Una fascia fuori dal campione resta vuota.
export function GraficoEventi({ andamento, serie = [], lang, t }) {
  const [ref, larghezza] = useLarghezza()
  const punti = andamento?.punti ?? 0
  const m = { sx: 34, dx: 10, su: 10, plot: 120, giu: 24 }
  const destra = Math.max(m.sx + 40, larghezza - m.dx)
  const banda = (destra - m.sx) / Math.max(1, punti)
  const x = useCallback((k) => m.sx + (k + 0.5) * banda, [banda, m.sx])
  const pile = impila(serie, punti)
  const hi = tondo(Math.max(1, ...pile.map((p) => p.totale ?? 0)))
  const y = (v) => m.su + m.plot - (v / hi) * m.plot
  const asse = m.su + m.plot
  const [i, mirino] = useMirino(punti, x)
  if (!punti) return null
  const w = Math.max(2, Math.min(24, banda - 2))
  // L'asse del tempo parte dal bordo sinistro della prima colonna, non dal suo centro.
  const xt = (k) => m.sx + k * banda
  return (
    <div className="ui-grafico" ref={ref}>
      <svg width={larghezza} height={asse + m.giu} tabIndex={0} role="img" aria-label={t('accessi.grafico.aria')} {...mirino}>
        <AsseValori dominio={[0, hi]} y={y} sinistra={m.sx} destra={destra} formato={(v) => (Number.isInteger(v) ? String(v) : '')} />
        <AsseTempo serie={andamento} x={xt} alto={m.su} basso={asse} lang={lang} griglia={false} />
        {i != null && <rect x={xt(i)} width={banda} y={m.su} height={m.plot} className="ui-fascia-mirino" />}
        {pile.map((p) => {
          const pieni = p.pezzi.filter((s) => s.v > 0)
          return pieni.map((s, n) => {
            const cima = n === pieni.length - 1
            // Due pixel di fondo fra un pezzo e quello sotto: la separazione e' aria, non un bordo.
            const giu = y(s.da) - (n > 0 ? 2 : 0)
            const top = y(s.a)
            const h = Math.max(1, giu - top)
            const sx = x(p.i) - w / 2
            const colore = serie.find((q) => q.k === s.k)?.colore
            if (!cima) return <rect key={s.k} x={sx} y={top} width={w} height={h} fill={colore} />
            const r = Math.min(3, h / 2, w / 2)
            const d = `M${sx},${top + h}V${top + r}Q${sx},${top} ${sx + r},${top}H${sx + w - r}Q${sx + w},${top} ${sx + w},${top + r}V${top + h}Z`
            return <path key={s.k} d={d} fill={colore} />
          })
        })}
        {pile.map((p) => (p.totale == null ? <rect key={`n${p.i}`} x={x(p.i) - w / 2} width={w} y={asse - 2} height={2} className="ui-ignoto" /> : null))}
      </svg>
      {i != null && (
        <Lettura
          x={x(i)}
          larghezza={larghezza}
          titolo={etichettaFascia(andamento.inizio + i * andamento.passoMs, andamento.passoMs, lang)}
          righe={[
            ...serie.map((s) => ({ colore: s.colore, etichetta: s.etichetta, valore: s.valori[i] == null ? '-' : String(s.valori[i]) })),
            { etichetta: t('accessi.grafico.persone'), valore: andamento.persone?.[i] == null ? '-' : String(andamento.persone[i]) },
          ]}
        />
      )}
    </div>
  )
}

// ── Piccoli multipli ────────────────────────────────────────────────────────────────────────────────
//
// Le serie di un Mac una sotto l'altra, ciascuna con la sua scala vera (`dominio`) ma tutte sullo
// stesso asse del tempo, che si scrive una volta sola in fondo. Il mirino attraversa tutte le righe,
// e il numero di ogni riga diventa quello dell'ora indicata: e' cosi' che si vede che lo swap e' salito
// nell'ora dell'OOM.
export function PiccoliMultipli({ serie: tempo, righe = [], lang, t }) {
  const [ref, larghezza] = useLarghezza(460)
  const punti = tempo?.punti ?? 0
  const m = { sx: 0, dx: 6, alta: 40, testa: 22, spazio: 12, giu: 22 }
  const destra = Math.max(60, larghezza - m.dx)
  const x = useCallback((k) => m.sx + 2 + (k * (destra - m.sx - 4)) / Math.max(1, punti - 1), [destra, punti, m.sx])
  const [i, mirino] = useMirino(punti, x)
  const visibili = righe.filter((r) => r.valori?.some((v) => v != null))
  if (!punti || !visibili.length) return null
  const altezzaRiga = m.testa + m.alta + m.spazio
  const fine = visibili.length * altezzaRiga
  return (
    <div className="ui-grafico ui-multipli" ref={ref}>
      <svg width={larghezza} height={fine + m.giu} tabIndex={0} role="img" aria-label={t('flotta.serie.aria')} {...mirino}>
        {visibili.map((r, n) => {
          const top = n * altezzaRiga
          const noti = r.valori.filter((v) => v != null)
          const lo = Math.min(r.dominio?.[0] ?? 0, ...noti)
          const hi = Math.max(r.dominio?.[1] ?? -Infinity, ...noti, lo + 1)
          const y = (v) => top + m.testa + m.alta - ((v - lo) / (hi - lo)) * m.alta
          const base = top + m.testa + m.alta
          const ultimo = r.valori.reduce((u, v, k) => (v != null ? k : u), -1)
          const k = i ?? ultimo
          const v = r.valori[k]
          return (
            <g key={r.k}>
              <text x={m.sx} y={top + 13} className="ui-multipli-nome">
                {r.etichetta}
              </text>
              <text x={destra} y={top + 13} textAnchor="end" className="ui-multipli-valore">
                {v == null ? '-' : r.formato(v)}
              </text>
              <line x1={m.sx} x2={destra} y1={base + 0.5} y2={base + 0.5} className="ui-base" />
              {r.forma === 'barre'
                ? r.valori.map((q, j) =>
                    q > 0 ? <rect key={j} x={x(j) - 2} width={4} y={y(q)} height={Math.max(2, base - y(q))} rx="1.5" fill={r.colore} /> : null,
                  )
                : (
                  <>
                    <path d={percorso(r.valori, x, y)} className="ui-linea" style={{ stroke: r.colore }} />
                    {ultimo >= 0 && i == null && <circle cx={x(ultimo)} cy={y(r.valori[ultimo])} r="3.5" className="ui-punto" style={{ fill: r.colore }} />}
                  </>
                )}
              {i != null && v != null && r.forma !== 'barre' && <circle cx={x(i)} cy={y(v)} r="3.5" className="ui-punto" style={{ fill: r.colore }} />}
            </g>
          )
        })}
        <AsseTempo serie={tempo} x={x} alto={0} basso={fine - m.spazio} lang={lang} griglia={false} />
        {i != null && <line x1={x(i)} x2={x(i)} y1={0} y2={fine - m.spazio} className="ui-mirino" />}
      </svg>
      <p className="ui-multipli-quando">
        {i != null ? etichettaFascia(tempo.inizio + i * tempo.passoMs, tempo.passoMs, lang) : t('flotta.serie.ultimo')}
      </p>
    </div>
  )
}
