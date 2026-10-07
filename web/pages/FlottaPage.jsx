import { useCallback, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Verdetto, Sezione, Pill, Dot, Meter, Sparkline, Drawer, BloccoComando, ListaLink } from '../ui/index.js'
import { usePoll } from '../usePoll.js'
import PollStatus from '../components/PollStatus.jsx'
import Loading from '../components/Loading.jsx'
import { fmtAgo, fmtMs } from '../format.js'
import { digestCorto } from '../../shared/devEnv.js'
import { linkAudit } from '../accessi.js'
import { fraseProblema, fraseAzione, valoreSerie, storiaImmagini } from '../flotta.js'
import './ops.css'
import './accessi.css'

// Superficie "Flotta": come stanno i Mac del dev-env, e cosa fare su quelli che non stanno bene.
//
// Perche' una pagina sua (07/10/2026): stava dentro Accessi come una colonna di una tabella larga,
// dove «nessun dato» riempiva le celle, il comando `tsh ssh` si ripeteva su ogni riga, e un Mac con
// tre processi uccisi per memoria era alto quanto uno sano. La domanda di questa pagina e' «quale Mac
// devo sistemare, e come?», e la risposta e' una card per Mac in ordine di gravita', ognuna col
// perche' a parole e l'UNICA azione che lo risolve. I Mac in ordine stanno in una riga sola.
//
// Le regole (cosa e' un problema, quanto e' grave, quale azione) le compone il server
// (`server/flotta.js`): sono le stesse dei messaggi del canale, e qui si disegnano e basta. Ogni campo
// e' facoltativo, perche' le macchine che non hanno aggiornato il dev-env non mandano quelli nuovi:
// un campo che manca non si scrive, invece di stampare «nessun dato» in una cella.
//
// ⚠️ Read-only come tutto il resto: le azioni sono frasi e comandi da copiare, mai eseguiti da qui.

const dataCorta = (ts, lang) => new Date(ts).toLocaleDateString(lang === 'it' ? 'it-IT' : 'en-GB')
const gb = (x, lang) => (x == null ? null : String(Math.round(x * 10) / 10).replace('.', lang === 'it' ? ',' : '.'))

export default function FlottaPage({ t, lang }) {
  const { data, loading, refreshing, error, lastUpdated } = usePoll('/api/flotta', { intervalMs: 60000 })
  const [params, setParams] = useSearchParams()
  const [saniAperti, setSaniAperti] = useState(false)

  // Il Mac aperto nel pannello sta nell'URL (`?mac=`): cosi' «guarda il Mac di kim» si manda come link,
  // ed e' dove portano i messaggi del canale.
  const aperto = params.get('mac')
  const apri = useCallback(
    (nome) => {
      const p = new URLSearchParams(params)
      if (nome) p.set('mac', nome)
      else p.delete('mac')
      setParams(p, { replace: true })
    },
    [params, setParams],
  )

  if (error && !data) return <div className="ui-readwarn">{String(error)}</div>
  if (loading || !data) return <Loading text={t('flotta.caricamento')} />
  if (!data.configurato) {
    return (
      <div className="ui-pagina">
        <Verdetto resto={t('flotta.title')} dettaglio={t('flotta.desc')} />
        <div className="acc-vuoto">{t('accessi.nonConfigurato')}</div>
      </div>
    )
  }

  const macchine = data.macchine ?? []
  const daSistemare = macchine.filter((m) => m.livello === 'crit' || m.livello === 'warn')
  const sani = macchine.filter((m) => !(m.livello === 'crit' || m.livello === 'warn'))
  const peggiore = daSistemare[0]?.livello ?? 'ok'
  const selezionata = macchine.find((m) => m.macchina === aperto) ?? null
  const rif = data.riferimento ?? {}

  return (
    <div className="ui-pagina">
      <Verdetto
        resto={
          <>
            {t('flotta.v.mac', { n: data.totale ?? macchine.length })}
            {' · '}
            <b className={`ui-t-${peggiore}`}>{daSistemare.length ? t('flotta.v.daSistemare', { n: daSistemare.length }) : t('flotta.v.tuttiInOrdine')}</b>
          </>
        }
        dettaglio={[rif.data ? t('flotta.v.golden', { data: dataCorta(rif.data, lang), quando: fmtAgo(rif.data, t) }) : null, t('flotta.v.fonti')]
          .filter(Boolean)
          .join(' · ')}
        extra={<PollStatus lastUpdated={lastUpdated} refreshing={refreshing} t={t} />}
      />

      {(data.errori ?? []).map((e) => (
        <div key={e} className="ui-readwarn">
          {e}
        </div>
      ))}
      {data.tuttiIndietro && <div className="ui-readwarn">{t('flotta.tuttiIndietro')}</div>}
      {!data.saluteConfigurata && <div className="ui-readwarn">{t('flotta.senzaSalute')}</div>}
      {data.troncato && <div className="ui-readwarn">{t('flotta.troncato')}</div>}

      {macchine.length === 0 && <div className="acc-vuoto">{t('accessi.nessunAvvio')}</div>}

      {daSistemare.length > 0 && (
        <Sezione titolo={t('flotta.daSistemare')} sotto={t('flotta.daSistemareSotto')}>
          <div className="fl-carte">
            {daSistemare.map((m) => (
              <CartaMac key={m.macchina} m={m} onApri={() => apri(m.macchina)} t={t} lang={lang} />
            ))}
          </div>
        </Sezione>
      )}

      {sani.length > 0 && (
        <section className="ui-sezione" id="in-ordine">
          <h2>{t('flotta.inOrdine')}</h2>
          <div className="fl-sani">
            <Dot livello="ok" />
            <span className="fl-sani-testo">
              {t('flotta.saniN', { n: sani.length })}{' '}
              {sani.map((m, i) => (
                <span key={m.macchina}>
                  {i > 0 && ', '}
                  <button type="button" className="ui-azione fl-nome" onClick={() => apri(m.macchina)}>
                    {m.macchina}
                  </button>
                </span>
              ))}
            </span>
            <button type="button" className="acc-chiusa-azione fl-sani-apri" aria-expanded={saniAperti} aria-controls="in-ordine-dentro" onClick={() => setSaniAperti(!saniAperti)}>
              {saniAperti ? t('accessi.chiudi') : t('accessi.mostra')}
            </button>
          </div>
          {saniAperti && (
            <div className="ui-lista fl-sani-lista" id="in-ordine-dentro">
              {sani.map((m) => (
                <button key={m.macchina} type="button" className="ui-row ui-row-btn fl-sano" onClick={() => apri(m.macchina)}>
                  <span className="ui-name">
                    {m.macchina}
                    <small>{[m.utente, m.motore].filter(Boolean).join(' · ')}</small>
                  </span>
                  <span className="ui-what ui-mute">
                    {[
                      m.vm?.gb != null ? t('flotta.vmGb', { gb: gb(m.vm.gb, lang) }) : null,
                      m.immagine?.creata ? t('flotta.immagineDel', { data: dataCorta(Date.parse(m.immagine.creata), lang) }) : null,
                      ...m.problemi.map((p) => fraseProblema(p, t, lang)),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="ui-when">{m.visto ? t('flotta.visto', { quando: fmtAgo(m.visto, t) }) : null}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      <Drawer
        aperto={Boolean(selezionata)}
        onChiudi={() => apri(null)}
        titolo={selezionata?.macchina}
        sopra={selezionata && <Pill livello={selezionata.livello}>{t(`flotta.liv.${selezionata.livello}`)}</Pill>}
        sotto={selezionata && [selezionata.utente, selezionata.motore, selezionata.vm?.ramMacGb != null ? t('flotta.ramMac', { gb: gb(selezionata.vm.ramMacGb, lang) }) : null].filter(Boolean).join(' · ')}
        etichettaChiudi={t('ui.chiudi')}
      >
        {selezionata && <DettaglioMac m={selezionata} dati={data} t={t} lang={lang} />}
      </Drawer>
    </div>
  )
}

// La memoria della VM contro il suo obiettivo, come barra: la differenza fra «11,7 GB» e «11,7 su 14»
// e' la differenza fra un numero e un problema.
function MemoriaVm({ vm, lang, t }) {
  const impostata = vm?.impostataGb ?? vm?.gb
  if (impostata == null || vm?.obiettivoGb == null) return null
  const pct = (impostata / vm.obiettivoGb) * 100
  return (
    <div className="fl-meter">
      <span>{t('flotta.vmSuObiettivo', { gb: gb(impostata, lang), obiettivo: gb(vm.obiettivoGb, lang) })}</span>
      <Meter valore={pct} livello={pct < 100 ? 'warn' : 'ok'} title={t('flotta.vmSuObiettivo', { gb: gb(impostata, lang), obiettivo: gb(vm.obiettivoGb, lang) })} />
    </div>
  )
}

function Azione({ azione, t, lang }) {
  if (!azione) return null
  return (
    <div className="fl-azione">
      <span className="fl-azione-label">{t('flotta.cosaFare')}</span>
      <b>{fraseAzione(azione, t, lang)}</b>
      {azione.comando && <BloccoComando comando={azione.comando} t={t} />}
    </div>
  )
}

// Una card per Mac con un problema: il PERCHE' in una frase grande, le altre cose in piccolo, e
// l'azione che risolve la prima. Niente comando `tsh ssh` qui: e' nel pannello, dove serve.
function CartaMac({ m, onApri, t, lang }) {
  const [primo, ...resto] = m.problemi
  const memoria = m.problemi.some((p) => p.tipo === 'oom' || p.tipo === 'vm-sotto-obiettivo') && m.vm?.obiettivoGb != null
  // La VM sotto l'obiettivo la dice gia' la barra: ripeterla in elenco e' rumore.
  const altri = resto.filter((p) => !(memoria && p.tipo === 'vm-sotto-obiettivo'))
  return (
    <article className={`fl-carta fl-${m.livello}`} aria-label={m.macchina}>
      <header>
        <Pill livello={m.livello}>{t(`flotta.liv.${m.livello}`)}</Pill>
        <span className="fl-carta-nome">
          <b>{m.macchina}</b>
          <small>{[m.utente, m.motore, m.visto ? t('flotta.visto', { quando: fmtAgo(m.visto, t) }) : null].filter(Boolean).join(' · ')}</small>
        </span>
      </header>
      <p className="fl-perche">{fraseProblema(primo, t, lang)}</p>
      {memoria && <MemoriaVm vm={m.vm} lang={lang} t={t} />}
      {altri.length > 0 && (
        <ul className="fl-altri">
          {altri.map((p) => (
            <li key={p.tipo}>
              <Dot livello={p.livello} />
              {fraseProblema(p, t, lang)}
            </li>
          ))}
        </ul>
      )}
      <Azione azione={primo.azione} t={t} lang={lang} />
      <footer>
        <button type="button" className="ui-azione" onClick={onApri}>
          {t('flotta.dettagli')} →
        </button>
      </footer>
    </article>
  )
}

// Le quattro serie del pannello, e la SCALA di ciascuna: fissa sulla grandezza vera (la memoria della
// VM, la RAM del Mac, i core della VM), cosi' una curva piatta resta piatta invece di essere stirata
// da bordo a bordo.
const SERIE = [
  { k: 'mem', unita: 'GB', livello: 'info', peggio: 'min', dominio: (m) => [0, m.vm?.gb ?? null] },
  { k: 'oom', unita: '', livello: 'crit', peggio: 'somma', dominio: () => [0, 1] },
  { k: 'swap', unita: 'GB', livello: 'warn', peggio: 'max', dominio: (m) => [0, m.vm?.ramMacGb ?? null] },
  { k: 'cpu', unita: '%', livello: 'info', peggio: 'max', dominio: (m) => [0, m.vm?.cpu ? m.vm.cpu * 100 : null] },
]

function DettaglioMac({ m, dati, t, lang }) {
  const ssh = dati.sshCommand && m.host ? dati.sshCommand.replace('{macchina}', m.macchina) : null
  const audit = linkAudit(dati.auditNodeUrl, 'macchina', m.macchina)
  const immagini = storiaImmagini(m.storia ?? [])
  const vmMb = (m.vm?.gb ?? 0) * 1024
  const uso = m.uso ?? {}
  const righeUso = [
    uso.ultimoUp && [t('flotta.uso.ultimoUp'), fmtAgo(Date.parse(uso.ultimoUp), t)],
    uso.ultimoUpdate && [t('flotta.uso.ultimoUpdate'), fmtAgo(Date.parse(uso.ultimoUpdate), t)],
    uso.doctor && [
      t('flotta.uso.doctor'),
      [
        t('flotta.uso.doctorEsito', { ok: uso.doctor.ok ?? '?', warn: uso.doctor.warn ?? 0, ko: uso.doctor.ko ?? 0 }),
        uso.doctor.quando ? fmtAgo(Date.parse(uso.doctor.quando), t) : null,
        uso.doctor.falliti?.length ? uso.doctor.falliti.join(', ') : null,
      ]
        .filter(Boolean)
        .join(' · '),
    ],
    uso.optOut?.length > 0 && [t('flotta.uso.optOut'), uso.optOut.join(', ')],
    uso.sulMac > 0 && [t('flotta.uso.sulMac'), t('flotta.uso.sulMacN', { b: uso.bloccati, f: uso.forzati })],
    m.host?.toolMancantiNomi?.length > 0 && [t('flotta.uso.tool'), m.host.toolMancantiNomi.join(', ')],
    (m.motore || m.motoreIncerto) && [t('flotta.uso.motore'), m.motore ?? t('flotta.motoreIncerto')],
    m.vm?.cpu != null && [t('flotta.uso.cpu'), String(m.vm.cpu)],
    // Lo swap ha la sua curva qui sopra: in tabella solo quando la curva non c'e'.
    !m.serie && m.swapGb != null && [t('flotta.uso.swap'), `${gb(m.swapGb, lang)} GB`],
  ].filter(Boolean)
  return (
    <>
      {m.problemi.length ? (
        <div className="fl-problemi">
          {m.problemi.map((p, i) => {
            // Due problemi con la stessa azione (la VM piccola e l'OOM che causa) la dicono una volta.
            const ripetuta = m.problemi.slice(0, i).some((q) => q.azione?.k === p.azione?.k && q.azione?.comando === p.azione?.comando)
            return (
              <div key={p.tipo} className={`fl-problema fl-${p.livello}`}>
                <b>{fraseProblema(p, t, lang)}</b>
                {ripetuta ? (
                  <span className="ui-faint">{t('flotta.stessaAzione')}</span>
                ) : (
                  <>
                    <span>{fraseAzione(p.azione, t, lang)}</span>
                    <BloccoComando comando={p.azione?.comando} t={t} />
                  </>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="ui-mute">{t('flotta.nienteDaSistemare')}</p>
      )}
      {m.saluteAssente && <p className="ui-faint">{t('flotta.saluteAssente')}</p>}
      {!m.saluteAssente && !m.vm?.gb && m.saluteUltima && <p className="ui-faint">{t('flotta.saluteVecchia', { quando: fmtAgo(m.saluteUltima, t) })}</p>}

      {m.serie && (
        <Sezione titolo={t('flotta.andamento')} sotto={t('flotta.andamentoSotto')}>
          <div className="fl-serie">
            {SERIE.map((s) => {
              const v = valoreSerie(m.serie[s.k], s.peggio)
              if (!v.punti) return null
              return (
                <div key={s.k} className="fl-serie-voce">
                  <span className="fl-serie-nome">{t(`flotta.serie.${s.k}`)}</span>
                  <b>
                    {s.k === 'oom' ? t('flotta.serie.oomTot', { n: v.totale }) : `${gb(v.ultimo, lang)}${s.unita ? ` ${s.unita}` : ''}`}
                  </b>
                  <Sparkline valori={(m.serie[s.k] ?? []).filter((x) => x != null)} livello={s.k === 'oom' && v.totale === 0 ? 'ok' : s.livello} larghezza={210} altezza={34} dominio={s.dominio(m)} />
                  <small className="ui-faint">
                    {s.k === 'oom'
                      ? t('flotta.serie.oomSotto')
                      : t(`flotta.serie.${s.k}Sotto`, { min: gb(v.min, lang), max: gb(v.max, lang) })}
                  </small>
                </div>
              )
            })}
          </div>
        </Sezione>
      )}

      {(m.contenitori ?? []).length > 0 && (
        <Sezione titolo={t('flotta.contenitori')} sotto={m.vm?.gb ? t('flotta.contenitoriSotto', { gb: gb(m.vm.gb, lang) }) : null}>
          <div className="fl-cont">
            {m.contenitori.map((c) => (
              <div key={c.nome} className="fl-cont-riga">
                <span className="ui-mono">{c.nome}</span>
                {vmMb > 0 && c.memMb != null ? <Meter valore={(c.memMb / vmMb) * 100} livello={c.memMb / vmMb > 0.35 ? 'warn' : 'brand'} /> : <span />}
                <span className="ui-mute">
                  {[c.memMb != null ? `${gb(c.memMb / 1024, lang)} GB` : null, c.cpuPct != null ? `CPU ${Math.round(c.cpuPct)}%` : null].filter(Boolean).join(' · ')}
                </span>
              </div>
            ))}
          </div>
        </Sezione>
      )}

      {(m.storia ?? []).length > 0 && (
        <Sezione titolo={t('flotta.avvii')}>
          <div className="fl-avvii">
            {m.storia.slice(0, 6).map((a, i) => (
              <div key={`${a.quando}-${i}`} className="fl-avvio">
                <Pill livello={a.esito === 'ok' ? 'ok' : a.esito === 'ko' ? 'crit' : a.esito ? 'warn' : 'off'}>{a.esito ?? '?'}</Pill>
                <span>
                  {fmtAgo(a.quando, t)}
                  {a.lato ? ` · ${a.lato}` : ''}
                  {a.durata != null ? ` · ${fmtMs(a.durata * 1000)}` : ''}
                  {(a.passo || a.classe || a.primaRiga) && (
                    <span className="ui-hint">{[a.passo && t('flotta.passo', { passo: a.passo }), a.classe, a.primaRiga].filter(Boolean).join(' · ')}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </Sezione>
      )}

      {immagini.length > 0 && (
        <Sezione titolo={t('flotta.immagini')}>
          <div className="fl-avvii">
            {immagini.map((im) => (
              <div key={`${im.immagine}-${im.dal}`} className="fl-avvio fl-immagine">
                <code className="ui-mono">{digestCorto(im.immagine) || t('flotta.nonDichiarata')}</code>
                <span className="ui-mute">
                  {[im.creata ? t('flotta.costruita', { data: dataCorta(Date.parse(im.creata), lang) }) : null, t('flotta.inUsoDa', { quando: fmtAgo(im.dal, t) })]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
            ))}
          </div>
        </Sezione>
      )}

      {righeUso.length > 0 && (
        <Sezione titolo={t('flotta.uso')}>
          <dl className="fl-uso">
            {righeUso.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </Sezione>
      )}

      {(ssh || audit) && (
        <Sezione titolo={t('flotta.entrare')} sotto={t('flotta.entrareSotto')}>
          {ssh && <BloccoComando comando={ssh} t={t} />}
          <ListaLink link={[{ label: t('flotta.audit'), href: audit, nota: t('accessi.vaiTeleportNota') }]} />
        </Sezione>
      )}
      <p className="ui-note">{t('home.soloLettura')}</p>
    </>
  )
}
