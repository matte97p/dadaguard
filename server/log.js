// Logger minimale strutturato (una riga JSON per evento): livello + messaggio + contesto.
// Niente dipendenze. In container il JSON è ingeribile da CloudWatch/Loki/ecc.; il livello si
// regola con LOG_LEVEL (error|warn|info|debug, default info).
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }
const LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info

function emit(level, msg, ctx) {
  if (LEVELS[level] > LEVEL) return
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(ctx || {}) })
  if (level === 'error') console.error(line)
  else console.log(line)
}

export const log = {
  error: (msg, ctx) => emit('error', msg, ctx),
  warn: (msg, ctx) => emit('warn', msg, ctx),
  info: (msg, ctx) => emit('info', msg, ctx),
  debug: (msg, ctx) => emit('debug', msg, ctx),
}
