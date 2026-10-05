// Menu laterale: le cinque pagine di tutti i giorni, e sotto una riga le cinque che servono solo a
// chi tiene l'infrastruttura.
//
// Il badge accanto alla voce e' il numero di cose che chiedono attenzione li' dentro: serve a sapere
// DOVE andare senza aprire tutte le pagine. Zero non si scrive, perche' un «0» rosso si legge come un
// allarme. Rosso se dentro c'e' qualcosa di rotto, arancio se c'e' solo da guardare.
//
// La sezione «Solo DevOps» non c'e' proprio per chi ha scelto Sviluppo: non e' un permesso (le rotte
// restano raggiungibili da un link), e' togliere dal campo visivo quello che a chi sviluppa non serve.
export default function SideNav({ voci = [], vociOps = [], attiva, onScegli, mostraOps = false, t = (k) => k }) {
  const voce = (v) => (
    <button
      key={v.to}
      type="button"
      data-nav={v.to}
      // La voce attiva si deduce dall'URL, non da uno stato da tenere in sincrono: e' cosi' che una
      // sidebar finisce a evidenziare la pagina sbagliata.
      aria-current={attiva === v.to ? 'page' : undefined}
      onClick={() => onScegli(v.to)}
    >
      {t(`nav.${v.key}`)}
      {v.n > 0 && <span className={`ui-n ${v.livello === 'warn' ? 'ui-warn' : ''}`}>{v.n}</span>}
    </button>
  )
  return (
    <nav className="ui-side" aria-label={t('shell.sezioni')}>
      {voci.map(voce)}
      {mostraOps && vociOps.length > 0 && (
        <>
          <div className="ui-sep" />
          <div className="ui-lbl">{t('shell.soloDevops')}</div>
          {vociOps.map(voce)}
        </>
      )}
    </nav>
  )
}
