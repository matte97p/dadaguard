import { Space, Tag, Tooltip, Typography } from 'antd'
import { SyncOutlined } from '@ant-design/icons'
import { fmtAgo, fmtMs, fmtSchedule } from '../format.js'
import { splitFamily, familyPrefixes } from '../serviceName.js'
import { FONT, MONO, SPACE } from '../theme.js'
import { OUTCOME_TAG, outcomeColor, runElapsed } from './runBits.jsx'

const { Text } = Typography

// TIMELINE delle esecuzioni: una riga per cron, dentro la riga le sue ultime corse come blocchi.
//
// Perché non una tabella: la tabella è una lista di fatti, e per rispondere «questo job sta bene?»
// bisogna leggerla riga per riga. Qui la risposta è la FORMA: un blocco che pulsa a destra è «sta
// girando adesso», un blocco molto più largo degli altri è «stanotte ha impiegato il triplo», uno rosso
// in mezzo a dei verdi è la corsa da aprire. Sono tutte cose che si vedono senza leggere.
//
// La larghezza è la durata, in RADICE QUADRATA: su un cron che di solito fa 4 secondi e una volta ne
// ha fatti 300, la scala lineare renderebbe le corse normali un filo invisibile. La radice comprime
// gli estremi e tiene le differenze leggibili: non è precisione, è confronto a occhio, e il numero
// esatto sta nel tooltip e nella vista lista.
const W_MIN = 9
const W_MAX = 96

export function blockWidth(durationMs, maxMs) {
  const d = Number(durationMs)
  if (!Number.isFinite(d) || d <= 0) return W_MIN
  const max = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : d
  return Math.round(W_MIN + (W_MAX - W_MIN) * Math.sqrt(Math.min(1, d / max)))
}

// Le corse da disegnare, dalla più vecchia (sinistra) alla più recente (destra), con la loro larghezza
// già calcolata sulla scala della RIGA (non su quella globale: due cron con durate diverse di ordini di
// grandezza non si confrontano fra loro, e fingere che si possa farlo mente). Pura/testabile.
export function stripBlocks(runs = [], now = Date.now(), max = 8) {
  const ultime = [...runs].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)).slice(-max)
  const durate = ultime.map((r) => runElapsed(r, now) ?? 0)
  const maxMs = Math.max(...durate, 1)
  return ultime.map((r, i) => ({ run: r, width: blockWidth(durate[i], maxMs), durationMs: durate[i] }))
}

function Blocco({ run, width, durationMs, t, onOpen, now }) {
  const colore = outcomeColor(run.outcome)
  const quando = run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'
  return (
    <Tooltip
      title={
        <span style={{ fontSize: FONT.small }}>
          {quando}
          <br />
          {t(`runs.outcome.${run.outcome}`)}
          {durationMs ? ` · ${fmtMs(durationMs)}` : ''}
          {run.exitCode != null && run.exitCode !== 0 ? ` · ${t('runs.exit', { code: run.exitCode })}` : ''}
          {run.timedOut ? ` · ${t('runs.timedOut')}` : ''}
          <br />
          <span style={{ opacity: 0.7 }}>{t('runs.openLogs')}</span>
        </span>
      }
    >
      <button
        type="button"
        aria-label={`${quando} · ${t(`runs.outcome.${run.outcome}`)}`}
        onClick={() => onOpen(run)}
        className={`dg-tl-block${run.running ? ' dg-tl-block-live' : ''}`}
        style={{
          width,
          background: colore,
          // La corsa in corso è l'unica che cresce: un filo di bordo la stacca anche a colori spenti
          // (e per chi non distingue quel verde da quel viola, il movimento resta il segnale).
          boxShadow: run.running ? `0 0 0 1px ${colore}` : 'none',
          opacity: run.outcome === 'unknown' ? 0.55 : 1,
        }}
      />
    </Tooltip>
  )
}

// Una riga: chi è il cron a sinistra, le sue corse a destra.
function Riga({ cron, t, onOpenRun, now, prefissi }) {
  const { family, tail } = splitFamily(cron.name, prefissi)
  const blocchi = stripBlocks(cron.runs, now)
  const ultima = cron.runs?.find((r) => !r.running) ?? null
  const viva = cron.runs?.find((r) => r.running) ?? null
  const primo = blocchi[0]?.run
  return (
    <div className="dg-tl-row" style={{ borderInlineStart: `3px solid ${outcomeColor(viva ? 'running' : cron.lastOutcome)}` }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SPACE.sm, minWidth: 0 }}>
          <button
            type="button"
            onClick={() => cron.onPick?.(cron.key)}
            style={{
              border: 0,
              background: 'none',
              padding: 0,
              cursor: cron.onPick ? 'pointer' : 'default',
              fontFamily: MONO,
              fontSize: FONT.body,
              fontWeight: 600,
              color: 'inherit',
              textAlign: 'start',
              overflowWrap: 'anywhere',
              minWidth: 0,
            }}
            title={cron.name}
          >
            {/* La testa condivisa piccola e muta, la coda in evidenza: i nostri cron si chiamano tutti
                `<org>-<ambiente>-cron-…`, quindi troncare da destra vuol dire troncare l'unica parte
                che serve. Niente è nascosto: il nome intero è testa + coda, letto di fila. */}
            {family && <span style={{ opacity: 0.42, fontWeight: 400 }}>{family}</span>}
            {tail}
          </button>
          {cron.accountLabel && (
            <Tag bordered={false} color={cron.color ?? undefined} style={{ marginInlineEnd: 0, fontSize: 10.5, lineHeight: '16px', padding: '0 5px' }}>
              {cron.accountLabel}
            </Tag>
          )}
        </div>
        <Space size={SPACE.sm} wrap style={{ rowGap: 0 }}>
          <Text type="secondary" style={{ fontSize: FONT.micro }}>
            {cron.scheduleMinutes ? fmtSchedule(`${cron.scheduleMinutes}m`, t) : t(`runs.type.${cron.type === 'lambda' ? 'lambda' : 'ecs'}`)}
          </Text>
          {/* La prossima partenza sta accanto alla cadenza: sono la stessa domanda («quando succede di
              nuovo»), e separarle costringe a cercarle in due punti. */}
          {cron.nextRunAt && (
            <Text type="secondary" style={{ fontSize: FONT.micro }}>
              {t('runs.nextAt', { time: new Date(cron.nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
            </Text>
          )}
          {!cron.enabled && (
            <Text type="secondary" style={{ fontSize: FONT.micro }}>
              {t('runs.disabled')}
            </Text>
          )}
        </Space>
      </div>

      <div style={{ minWidth: 0 }}>
        <div className="dg-tl-strip">
          {blocchi.map((b) => (
            <Blocco key={b.run.id ?? b.run.startedAt} {...b} t={t} now={now} onOpen={(r) => onOpenRun(cron, r)} />
          ))}
        </div>
        <div className="dg-tl-axis">
          <span>{primo?.startedAt ? fmtAgo(primo.startedAt, t) : ''}</span>
          {/* A destra non l'orario dell'ultima corsa ma il suo ESITO in parole: la striscia dice già
              «quando», e quello che si vuole leggere in fondo alla riga è com'è andata. */}
          <span>
            {viva ? (
              <Space size={4}>
                <SyncOutlined spin style={{ fontSize: 10 }} />
                {t('runs.for', { d: fmtMs(runElapsed(viva, now) ?? 0) })}
              </Space>
            ) : ultima ? (
              `${t(`runs.outcome.${ultima.outcome}`)}${runElapsed(ultima) ? ` · ${fmtMs(runElapsed(ultima))}` : ''}`
            ) : (
              ''
            )}
          </span>
        </div>
      </div>
    </div>
  )
}

export default function RunTimeline({ crons = [], t = (k) => k, onOpenRun = () => {}, onPickCron = null, now = Date.now() }) {
  // I prefissi si contano sul GRUPPO mostrato, non su un elenco fisso: è l'unico modo perché la testa
  // muta sia la stessa su tutte le righe (l'occhio la salta una volta e non ci torna).
  const prefissi = familyPrefixes(crons.map((c) => c.name))
  return (
    <div>
      {crons.map((c) => (
        <Riga
          key={c.key}
          cron={onPickCron ? { ...c, onPick: onPickCron } : c}
          t={t}
          onOpenRun={onOpenRun}
          now={now}
          prefissi={prefissi}
        />
      ))}
    </div>
  )
}

export { OUTCOME_TAG }
