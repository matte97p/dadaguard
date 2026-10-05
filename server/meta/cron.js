// Durata tipica di un cron: la MEDIANA delle corse riuscite gia' lette dalla vista esecuzioni. La
// mediana e non la media perche' una corsa rimasta appesa un'ora sposterebbe la media per giorni, e
// «tipica» vuol dire quella che succede di solito. Meno di due corse riuscite → null: con un campione
// solo non c'e' niente di tipico. Pura/testabile.
export function durataTipica(runs = []) {
  const d = runs
    .filter((r) => r?.outcome === 'ok' && r.startedAt != null && r.endedAt != null)
    .map((r) => new Date(r.endedAt) - new Date(r.startedAt))
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .sort((a, b) => a - b)
  if (d.length < 2) return null
  const m = Math.floor(d.length / 2)
  return d.length % 2 ? d[m] : Math.round((d[m - 1] + d[m]) / 2)
}

// Aggiunge `durataTipicaMs` a ogni cron della risposta di `/api/runs`, senza togliere niente.
export function conDurataTipica(overview = {}) {
  if (!Array.isArray(overview.crons)) return overview
  return { ...overview, crons: overview.crons.map((c) => ({ ...c, durataTipicaMs: durataTipica(c.runs) })) }
}
