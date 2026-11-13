import pg from 'pg'
import { cached } from '../util/ttlcache.js'

// Dentro il database: quanto pesa ogni schema e ogni tabella, righe morte, vacuum in ritardo, indici
// mai usati, letture dalla memoria, connessioni e lock. Si legge SOLO dalle viste di statistica di
// Postgres (`pg_stat_*`, `pg_class`), mai dai dati: basta un utente col ruolo `pg_read_all_stats`.
//
// È OPZIONALE e spento finché non si configura: `DADAGUARD_PG_URLS` con una o più coppie
// `id=postgresql://utente:password@host:5432/db`, separate da `;`. L'`id` è l'identificativo
// dell'istanza RDS (così le statistiche finiscono sulla sua riga); la password è un segreto e va
// passata come tale (variabile d'ambiente dal secret store), mai scritta in services.yaml.
// Dadaguard deve raggiungere il database in rete: in un altro account o VPC serve una strada.
//
// Ogni sessione è in sola lettura (`default_transaction_read_only`) con un timeout corto: una query
// lenta qui non deve mai pesare sul database che si sta guardando.

const TTL = 10 * 60 * 1000
const TIMEOUT_MS = 8000
const TABELLE = 60

// `id=url;id=url` → [{ id, url }]. Puro. Le voci malformate si scartano.
export function leggiUrl(valore = process.env.DADAGUARD_PG_URLS ?? '') {
  return String(valore)
    .split(';')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => {
      const i = v.indexOf('=')
      return i > 0 ? { id: v.slice(0, i).trim(), url: v.slice(i + 1).trim() } : null
    })
    .filter((v) => v?.id && /^postgres(ql)?:\/\//.test(v.url))
}

const Q_SCHEMI = `
select n.nspname as schema,
       count(*)::int as tabelle,
       coalesce(sum(c.reltuples) filter (where c.reltuples > 0), 0)::float8 as righe,
       sum(pg_relation_size(c.oid))::float8 as heap,
       sum(pg_indexes_size(c.oid))::float8 as indici,
       sum(pg_total_relation_size(c.oid) - pg_relation_size(c.oid) - pg_indexes_size(c.oid))::float8 as toast
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'm', 'p') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
group by n.nspname order by sum(pg_total_relation_size(c.oid)) desc`

const Q_TABELLE = `
select s.schemaname as schema, s.relname as tabella,
       s.n_live_tup::float8 as vive, s.n_dead_tup::float8 as morte,
       s.seq_scan::float8 as letture_intere, coalesce(s.idx_scan, 0)::float8 as letture_indice,
       greatest(s.last_vacuum, s.last_autovacuum) as ultimo_vacuum,
       pg_total_relation_size(s.relid)::float8 as totale, pg_relation_size(s.relid)::float8 as heap
from pg_stat_user_tables s order by pg_total_relation_size(s.relid) desc limit ${TABELLE}`

const Q_INDICI = `
select s.schemaname as schema, s.relname as tabella, s.indexrelname as indice,
       pg_relation_size(s.indexrelid)::float8 as byte
from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid
where s.idx_scan = 0 and not i.indisunique and not i.indisprimary
order by pg_relation_size(s.indexrelid) desc limit 50`

const Q_DB = `
select (select sum(blks_hit)::float8 / nullif(sum(blks_hit) + sum(blks_read), 0) from pg_stat_database where datname = current_database()) as memoria,
       (select count(*)::int from pg_stat_activity) as connessioni,
       (select count(*)::int from pg_stat_activity where wait_event_type = 'Lock') as in_attesa,
       current_setting('max_connections')::int as limite,
       pg_database_size(current_database())::float8 as dimensione,
       (select stats_reset from pg_stat_database where datname = current_database()) as dal`

// Le tabelle che chiedono attenzione, con soglie dichiarate qui. Puro.
export const MORTE_SOGLIA = 0.2 // oltre il 20% di righe morte la tabella occupa e legge più del dovuto
export const MORTE_MIN_BYTE = 256 * 1024 ** 2 // sotto i 256 MB non vale la pena guardarle
export const INTERE_MIN = 1000 // letture intere da quando ci sono le statistiche
export function segnaliTabella(t) {
  const out = []
  const tot = t.vive + t.morte
  if (t.totale >= MORTE_MIN_BYTE && tot > 0 && t.morte / tot >= MORTE_SOGLIA) out.push('morte')
  if (t.heap >= MORTE_MIN_BYTE && t.letture_intere >= INTERE_MIN && t.letture_intere > t.letture_indice) out.push('intere')
  return out
}

export function statistichePostgres({ id, url }) {
  return cached(`eff:pg:${id}`, TTL, async () => {
    const client = new pg.Client({
      connectionString: url,
      statement_timeout: TIMEOUT_MS,
      query_timeout: TIMEOUT_MS,
      connectionTimeoutMillis: TIMEOUT_MS,
      application_name: 'dadaguard',
      options: '-c default_transaction_read_only=on',
    })
    await client.connect()
    try {
      const [schemi, tabelle, indici, db] = await Promise.all([client.query(Q_SCHEMI), client.query(Q_TABELLE), client.query(Q_INDICI), client.query(Q_DB)])
      return {
        db: db.rows[0] ?? null,
        schemi: schemi.rows,
        tabelle: tabelle.rows.map((t) => ({ ...t, segnali: segnaliTabella(t) })),
        indiciInutili: indici.rows,
      }
    } finally {
      await client.end().catch(() => {})
    }
  })
}

// Le statistiche di tutti i database configurati: { id: dati | { errore } }. Senza configurazione: {}.
export async function postgresConfigurati() {
  const voci = leggiUrl()
  const out = {}
  await Promise.all(
    voci.map(async (v) => {
      try {
        out[v.id] = await statistichePostgres(v)
      } catch (err) {
        // Il messaggio di pg può contenere l'host ma mai la password; si tiene solo il codice e il testo.
        out[v.id] = { errore: String(err?.code ? `${err.code} ${err.message}` : err?.message ?? err).replace(/postgres(ql)?:\/\/\S+/g, 'postgresql://…') }
      }
    }),
  )
  return out
}
