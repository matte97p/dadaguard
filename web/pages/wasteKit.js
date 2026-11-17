// Logica pura della scheda Sprechi (niente JSX): così la provano i test con node, senza bundler.

// Costruisce le voci con MOTIVO + livello: 'spreco' (quasi certo), 'verifica' (costo fisso che
// è spreco solo in certe condizioni) o 'riserva' (ferma apposta, dichiarata col tag: non è spreco). Senza il motivo, un numero da solo non dice niente.
// Ogni voce porta anche le RISORSE coinvolte (`names`: { id, meta }): un conteggio da solo non è
// azionabile ("2 DB inattivi" → quali?), e il COMANDO che le mostra, che è quello da cui si decide
// (Dadaguard non cancella niente: il comando legge, la decisione resta a chi lo lancia).
export function buildItems(v, t) {
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
      names: v.idleInstances.map((i) => ({ id: i.id, meta: metaEc2(i, t) })),
      comando: comandoEc2,
    })
  }
  if (v.idleDatabases?.length) {
    out.push({
      key: 'rds',
      title: t('waste.idleRds.title', { n: v.idleDatabases.length }),
      level: 'verifica',
      reason: t('waste.idleRds.reason'),
      names: v.idleDatabases.map((d) => ({ id: d.id, meta: t('waste.util', { avg: d.cpuAvg, peak: d.cpuMax }) })),
      comando: comandoRds,
    })
  }
  // Ferme ma dichiarate riserva col tag: fuori dal conteggio degli sprechi, ma in vista, col motivo, perché
  // una riserva dimenticata si ritrovi.
  if (v.standbyInstances?.length) {
    out.push({
      key: 'ec2Standby',
      title: t('waste.standbyEc2.title', { n: v.standbyInstances.length }),
      level: 'riserva',
      reason: t('waste.standby.reason'),
      names: v.standbyInstances.map((i) => ({ id: i.id, meta: [i.standby, metaEc2(i, t)].filter(Boolean).join(' · ') })),
      comando: comandoEc2,
    })
  }
  if (v.standbyDatabases?.length) {
    out.push({
      key: 'rdsStandby',
      title: t('waste.standbyRds.title', { n: v.standbyDatabases.length }),
      level: 'riserva',
      reason: t('waste.standby.reason'),
      names: v.standbyDatabases.map((d) => ({
        id: d.id,
        meta: [d.standby, t('waste.util', { avg: d.cpuAvg, peak: d.cpuMax })].filter(Boolean).join(' · '),
      })),
      comando: comandoRds,
    })
  }
  return out
}

const metaEc2 = (i, t) =>
  [i.type, t('waste.util', { avg: i.cpuAvg, peak: i.cpuMax }), i.netMbDay != null ? t('waste.net', { mb: i.netMbDay }) : null]
    .filter(Boolean)
    .join(' · ')
const comandoEc2 = (ids) => `aws ec2 describe-instances --instance-ids ${ids.join(' ')}`
// describe-db-instances prende un identificativo per volta: con piu' database li elenca tutti.
const comandoRds = (ids) =>
  ids.length === 1
    ? `aws rds describe-db-instances --db-instance-identifier ${ids[0]}`
    : `aws rds describe-db-instances --query "DBInstances[?contains('${ids.join(',')}', DBInstanceIdentifier)]"`

// Ordine di lettura: prima lo spreco certo, poi quello da verificare, in fondo le riserve dichiarate.
export const ORDINE = { spreco: 0, verifica: 1, riserva: 2 }
export const PILL = {
  spreco: ['warn', 'waste.level.waste'],
  verifica: ['info', 'waste.level.check'],
  riserva: ['off', 'waste.level.standby'],
}
export const RIMEDIO = {
  spreco: 'spend.sprechi.fare.spreco',
  verifica: 'spend.sprechi.fare.verifica',
  riserva: 'spend.sprechi.fare.riserva',
}

// Quante risorse sospette ci sono negli account visibili: il numero sulla scheda «Sprechi». Puro.
export function contaSprechi(dati, accountLabels, t = (k) => k) {
  return Object.values(dati ?? {})
    .filter((v) => !v.error && (!accountLabels || accountLabels.has(v.label)))
    // Le riserve dichiarate non sono sprechi: non entrano nel numero sulla scheda.
    .reduce((s, v) => s + buildItems(v, t).filter((it) => it.level !== 'riserva').reduce((a, it) => a + it.names.length, 0), 0)
}
