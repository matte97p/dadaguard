import { Verdetto } from '../ui/index.js'
import { contaLivelli, livelloServizio } from '../adattatori.js'

// Il verdetto in cima a Servizi: quanti ne guardi e, se qualcosa non va, quanti sono rotti e quanti
// da guardare, nella parte colorata. I conteggi sono sulla flotta dell'ambiente scelto e non sul
// filtrato: il numero grande deve dire la verita' anche con una ricerca dimenticata nel campo, e per
// questo con un filtro attivo il dettaglio dice «N di M».
export default function StatusSummary({ services = [], all = null, ambiente, extra, t = (k) => k }) {
  const flotta = all ?? services
  const c = contaLivelli(flotta)
  const filtrato = services.length !== flotta.length
  const dove = ambiente ?? t('svc.tuttiAmbienti')
  const dettaglio = filtrato
    ? t('svc.v.mostrati', { n: services.length, tot: flotta.length, dove })
    : t('svc.v.in', { tot: flotta.length, dove })
  if (c.crit) {
    return (
      <Verdetto
        livello="crit"
        forte={t('svc.v.rotti', { n: c.crit })}
        resto={c.warn ? t('svc.v.eDaGuardare', { n: c.warn }) : ''}
        dettaglio={dettaglio}
        extra={extra}
      />
    )
  }
  // Un job schedulato la cui ultima esecuzione e' fallita e' giallo (non serve nessuno adesso) ma
  // la scheda «Giù» lo conta: dire «niente di rotto» sopra «Giù 2» faceva sembrare la pagina scritta
  // da due persone. Si dice cosa sono.
  const falliti = flotta.filter((s) => s?.overall === 'down' && livelloServizio(s) === 'warn').length
  if (c.warn)
    return (
      <Verdetto
        livello="warn"
        forte={t('svc.v.daGuardare', { n: c.warn })}
        resto={falliti ? t('svc.v.eFalliti', { n: falliti }) : t('svc.v.nienteRotto')}
        dettaglio={dettaglio}
        extra={extra}
      />
    )
  return (
    <Verdetto
      livello={flotta.length ? 'ok' : undefined}
      forte={flotta.length ? t('svc.v.tuttiOk') : null}
      resto={flotta.length ? '' : t('svc.titolo')}
      dettaglio={dettaglio}
      extra={extra}
    />
  )
}
