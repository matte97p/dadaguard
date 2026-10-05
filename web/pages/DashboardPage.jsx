import { useMemo, useState } from 'react'
import { Lista } from '../ui/index.js'
import ServiceCard from '../components/ServiceCard.jsx'
import ServicesTable, { famigliePerAccount, perGravita } from '../components/ServicesTable.jsx'
import StatusSummary from '../components/StatusSummary.jsx'
import { FiltroServizi } from '../components/FilterBar.jsx'
import { matchesAny } from '../filters.js'
import { serviceKey } from '../serviceName.js'
import { passaChip, contaChip } from '../servizi.js'

// Pagina Servizi: il verdetto in una frase, l'avviso se qualche account non si e' potuto leggere,
// la ricerca coi tre chip, e la lista dal piu' grave. Ogni riga apre il pannello del servizio, dove
// stanno cosa fare, i controlli spiegati, i log e i link alle console.
//
// I servizi arrivano gia' filtrati da App (ambiente scelto, ricerca, filtri salvati); qui si
// applicano solo i chip, che sono uno stato della pagina e non della flotta.
const leggi = (k, d) => {
  try {
    return localStorage.getItem(k) ?? d
  } catch {
    return d
  }
}
const scrivi = (k, v) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* senza storage la scelta vale per questa visita */
  }
}

export default function DashboardPage({
  data,
  groups,
  allServices = [],
  accountFilter = [],
  ambienteLabel,
  nameQuery = '',
  onNameQuery,
  filtersActive,
  onResetFilters,
  loading,
  error,
  onOpen,
  t,
}) {
  // Lista o card. Oltre la ventina di servizi la lista vince; le card restano per le flotte piccole
  // e per chi le preferisce. La scelta si ricorda, come prima.
  const [view, setView] = useState(() => leggi('dadaguard-view', 'table'))
  const pickView = (v) => (scrivi('dadaguard-view', v), setView(v))
  const [chip, setChip] = useState('tutti')

  const filtrati = useMemo(() => groups.flatMap((g) => g.services), [groups])
  const conteggi = contaChip(filtrati)
  const visibili = filtrati.filter((s) => passaChip(s, chip))
  // La flotta dell'ambiente, senza ricerca: e' il totale vero contro cui leggere il filtrato.
  const ambiente = useMemo(
    () => allServices.filter((s) => matchesAny(s.account?.key ?? '__none__', accountFilter)),
    [allServices, accountFilter],
  )
  const famiglie = useMemo(() => famigliePerAccount(visibili), [visibili])

  const vista = (
    <div className="sv-tools">
      <div className="ui-seg" role="group" aria-label={t('svc.vista')} data-view="view-switch">
        {['table', 'cards'].map((v) => (
          <button key={v} type="button" aria-pressed={view === v} onClick={() => pickView(v)}>
            {t(`svc.vista.${v}`)}
          </button>
        ))}
      </div>
      {data?.generatedAt && (
        <span className="ui-faint">
          {t('content.lastFetch')} {new Date(data.generatedAt).toLocaleTimeString()}
        </span>
      )}
    </div>
  )

  return (
    <>
      <div data-view="summary">
        <StatusSummary services={visibili} all={ambiente} ambiente={ambienteLabel} extra={data ? vista : null} t={t} />
      </div>

      {/* Account in cui una lettura e' FALLITA. In pagina quell'account sembrava semplicemente vuoto,
          e «non c'e' niente» e' l'opposto di «non sono riuscito a guardare». Non si chiude: un
          avviso che si fa sparire su un dato che manca torna a essere una bugia comoda. */}
      {data?.discoveryProblems?.length > 0 && (
        <div className="ui-readwarn" role="status">
          <b>{t('svc.nonLeggibili', { n: data.discoveryProblems.length })}</b>{' '}
          {data.discoveryProblems
            .map((p) => `${p.account}${p.region ? ` (${p.region})` : ''}: ${(p.problems ?? []).map((x) => x.what).join(', ')}`)
            .join(' · ')}
          . {t('svc.nonLeggibiliSotto')}
          {data.discoveryProblems.some((p) => p.problems?.some((x) => x.err)) && (
            <details>
              <summary>{t('svc.nonLeggibiliErrori')}</summary>
              {data.discoveryProblems.flatMap((p) =>
                (p.problems ?? []).map((x, i) => (
                  <div key={`${p.account}/${p.region}/${i}`} className="ui-mono ui-mute">
                    {p.account} · {x.what}: {x.err}
                  </div>
                )),
              )}
            </details>
          )}
        </div>
      )}
      {data?.discovered && <p className="ui-note">{t('discover.autoDesc', { n: data.discovered.count })}</p>}
      {error && <div className="ui-readwarn">{`${t('content.errorPrefix')} ${error}`}</div>}

      {data && <FiltroServizi query={nameQuery} onQuery={(v) => onNameQuery?.(v)} chip={chip} onChip={setChip} conteggi={conteggi} t={t} />}
      {filtersActive && onResetFilters && (
        <p className="ui-note">
          {t('svc.filtriAttivi')}{' '}
          <button type="button" className="ui-kbd" onClick={onResetFilters}>
            {t('filter.reset')}
          </button>
        </p>
      )}

      {loading && !data && <Lista vuoto={t('home.inLettura')} />}
      {data && view === 'table' && <ServicesTable services={visibili} onOpen={onOpen} t={t} />}
      {data &&
        view === 'cards' &&
        (visibili.length ? (
          <div className="sv-grid">
            {[...visibili].sort(perGravita).map((s) => (
              <ServiceCard key={serviceKey(s)} service={s} famiglie={famiglie.get(s.account?.key ?? '-')} onOpen={onOpen} t={t} />
            ))}
          </div>
        ) : (
          <Lista vuoto={t('svc.vuoto')} />
        ))}
    </>
  )
}
