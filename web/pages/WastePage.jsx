import { useState } from 'react'
import { Lista, Sezione, Pill, Drawer, Rimedio, ListaLink, BloccoComando } from '../ui/index.js'
import { soldi } from './spesaKit.js'

// Costruisce le voci con MOTIVO + livello: 'spreco' (quasi certo) o 'verifica' (costo fisso che
// è spreco solo in certe condizioni). Senza il motivo, un numero da solo non dice niente.
// Ogni voce porta anche le RISORSE coinvolte (`names`: { id, meta }): un conteggio da solo non è
// azionabile ("2 DB inattivi" → quali?), e il COMANDO che le mostra, che è quello da cui si decide
// (Dadaguard non cancella niente: il comando legge, la decisione resta a chi lo lancia).
function buildItems(v, t) {
  const out = []
  if (v.eips?.length) {
    out.push({
      key: 'eip',
      title: t('waste.eip.title', { n: v.eips.length, cost: Math.round(v.eips.length * 3.6) }),
      level: 'spreco',
      reason: t('waste.eip.reason'),
      names: v.eips.map((e) => ({ id: e.ip || e.id })),
      comando: (ids) => `aws ec2 describe-addresses --public-ips ${ids.join(' ')}`,
    })
  }
  if (v.natGateways?.length) {
    out.push({
      key: 'nat',
      title: t('waste.nat.title', { n: v.natGateways.length, cost: v.natGateways.length * 32 }),
      level: 'verifica',
      reason: t('waste.nat.reason'),
      names: v.natGateways.map((n) => ({ id: n.id })),
      comando: (ids) => `aws ec2 describe-nat-gateways --nat-gateway-ids ${ids.join(' ')}`,
    })
  }
  if (v.volumes?.length) {
    out.push({
      key: 'ebs',
      title: t('waste.ebs.title', { n: v.volumes.length, gb: v.volumes.reduce((s, x) => s + x.sizeGb, 0) }),
      level: 'spreco',
      reason: t('waste.ebs.reason'),
      names: v.volumes.map((x) => ({ id: x.id, meta: `${x.sizeGb} GB` })),
      comando: (ids) => `aws ec2 describe-volumes --volume-ids ${ids.join(' ')}`,
    })
  }
  // Risorse accese ma ~ferme (istanziate ma non usate). Livello 'verifica': idle ≠ spreco certo
  // (potrebbe essere una riserva/HA), quindi non entrano nel totale a listino.
  if (v.idleInstances?.length) {
    out.push({
      key: 'ec2',
      title: t('waste.idleEc2.title', { n: v.idleInstances.length }),
      level: 'verifica',
      reason: t('waste.idleEc2.reason'),
      names: v.idleInstances.map((i) => ({ id: i.id, meta: `${i.type} · ${t('waste.util', { avg: i.cpuAvg, peak: i.cpuMax })}` })),
      comando: (ids) => `aws ec2 describe-instances --instance-ids ${ids.join(' ')}`,
    })
  }
  if (v.idleDatabases?.length) {
    out.push({
      key: 'rds',
      title: t('waste.idleRds.title', { n: v.idleDatabases.length }),
      level: 'verifica',
      reason: t('waste.idleRds.reason'),
      names: v.idleDatabases.map((d) => ({ id: d.id, meta: t('waste.util', { avg: d.cpuAvg, peak: d.cpuMax }) })),
      // describe-db-instances prende un identificativo per volta: con piu' database li elenca tutti.
      comando: (ids) =>
        ids.length === 1
          ? `aws rds describe-db-instances --db-instance-identifier ${ids[0]}`
          : `aws rds describe-db-instances --query "DBInstances[?contains('${ids.join(',')}', DBInstanceIdentifier)]"`,
    })
  }
  return out
}

// Quante risorse sospette ci sono negli account visibili: il numero sulla scheda «Sprechi». Puro.
export function contaSprechi(dati, accountLabels, t = (k) => k) {
  return Object.values(dati ?? {})
    .filter((v) => !v.error && (!accountLabels || accountLabels.has(v.label)))
    .reduce((s, v) => s + buildItems(v, t).reduce((a, it) => a + it.names.length, 0), 0)
}

// Dove si guarda una risorsa ferma in console. La regione si mette se il server la manda; senza, la
// console apre quella in cui eri l'ultima volta, che e' quasi sempre quella giusta.
const CONSOLE = {
  eip: ['ec2', 'Addresses:'],
  nat: ['vpcconsole', 'NatGateways:'],
  ebs: ['ec2', 'Volumes:'],
  ec2: ['ec2', 'Instances:'],
  rds: ['rds', 'databases:'],
}
const linkConsole = (key, region) => {
  const c = CONSOLE[key]
  if (!c) return null
  return region
    ? `https://${region}.console.aws.amazon.com/${c[0]}/home?region=${region}#${c[1]}`
    : `https://console.aws.amazon.com/${c[0]}/home#${c[1]}`
}

const GRIGLIA = '110px minmax(0,1fr) 140px'

// Scheda Sprechi: risorse a costo fisso che sembrano inutilizzate, per account. Una riga per voce,
// dal certo al da verificare, e il pannello con le risorse e il comando che le mostra.
//
// I dati arrivano da SpendPage (`risposta`), che li legge comunque per il numero sulla scheda.
export default function WastePage({ accountLabels, t = (k) => k, lang, risposta }) {
  const [aperta, setAperta] = useState(null)
  if (!risposta) return <p className="ui-mute">{t('spend.carico')}</p>
  const errore = risposta.errore ?? risposta.dati?.error
  if (errore) return <Rimedio livello="warn" titolo={t('spend.sprechi.errore')} testo={errore} t={t} />

  const entries = Object.entries(risposta.dati ?? {}).filter(([, v]) => !accountLabels || accountLabels.has(v.label))
  const total = entries.reduce((s, [, v]) => s + (v.estMonthlyUsd || 0), 0)
  const righe = entries
    .flatMap(([key, v]) => (v.error ? [] : buildItems(v, t).map((it) => ({ ...it, conto: v.label, region: v.region, chiave: `${key}/${it.key}` }))))
    // Prima lo spreco certo, poi quello da verificare: e' l'ordine in cui conviene leggerli.
    .sort((a, b) => (a.level === b.level ? 0 : a.level === 'spreco' ? -1 : 1))
  const errori = entries.filter(([, v]) => v.error)

  return (
    <>
      <Sezione
        titolo={t('spend.sprechi.titolo')}
        sotto={total > 0 ? t('spend.sprechi.sotto', { v: soldi(total, lang) }) : t('waste.v.ok')}
      >
        <Lista colonne={[t('spend.col.stato'), t('spend.col.cosa'), t('spend.col.conto')]} griglia={GRIGLIA} vuoto={t('waste.v.okTitolo')}>
          {righe.map((r) => (
            <button
              key={r.chiave}
              type="button"
              className="ui-row ui-row-btn"
              style={{ gridTemplateColumns: GRIGLIA }}
              onClick={() => setAperta(r)}
            >
              <Pill livello={r.level === 'spreco' ? 'warn' : 'info'}>{r.level === 'spreco' ? t('waste.level.waste') : t('waste.level.check')}</Pill>
              <span className="ui-what">
                {r.title}
                <span className="ui-hint">{r.names.map((n) => n.id).join(', ')}</span>
              </span>
              <span className="ui-mute">{r.conto}</span>
            </button>
          ))}
        </Lista>
        {errori.map(([key, v]) => (
          <p key={key} className="ui-note">
            {v.label}: {v.error}
          </p>
        ))}
      </Sezione>
      <p className="ui-note">{t('spend.sprechi.nota')}</p>

      <Drawer aperto={Boolean(aperta)} onChiudi={() => setAperta(null)} titolo={aperta?.title} sotto={aperta?.conto} etichettaChiudi={t('ui.chiudi')}>
        {aperta && (
          <>
            <p className="ui-mute">{aperta.reason}</p>
            <Lista>
              {aperta.names.map((n) => (
                <div key={n.id} className="ui-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                  <span className="ui-mono" style={{ overflowWrap: 'anywhere' }}>
                    {n.id}
                  </span>
                  <span className="ui-mute">{n.meta}</span>
                </div>
              ))}
            </Lista>
            <Rimedio
              livello={aperta.level === 'spreco' ? 'warn' : undefined}
              titolo={t('spend.cosaFare')}
              testo={aperta.level === 'spreco' ? t('spend.sprechi.fare.spreco') : t('spend.sprechi.fare.verifica')}
              t={t}
            />
            <BloccoComando comando={aperta.comando(aperta.names.map((n) => n.id))} t={t} />
            <ListaLink
              link={[
                {
                  label: t('spend.link.console'),
                  href: linkConsole(aperta.key, aperta.region),
                  nota: t('spend.link.nota', { conto: aperta.conto }),
                },
              ]}
            />
          </>
        )}
      </Drawer>
    </>
  )
}
