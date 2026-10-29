import assert from 'node:assert/strict'

export function replayRuntime(rows, through = '') {
  const limit = through === '' ? Infinity : Date.parse(through)
  assert.ok(limit === Infinity || Number.isFinite(limit), 'A runtime cutoff needs a valid business time')
  const selected = rows.filter(row => Date.parse(row.at) <= limit)
  if (!selected.length) return null
  const groups = new Map()
  let started = Infinity, finished = -Infinity, business = -Infinity
  for (const row of selected) {
    const at = Date.parse(row.at), realAt = Date.parse(row.realAt)
    assert.ok(Number.isFinite(at) && Number.isFinite(realAt) && Number.isFinite(row.durationMs) && row.durationMs >= 0, 'Runtime rows need measured dates and duration')
    started = Math.min(started, realAt - row.durationMs)
    finished = Math.max(finished, realAt)
    business = Math.max(business, at)
    const total = groups.get(row.function) ?? { function: row.function, calls: 0, durationMs: 0, errors: 0 }
    total.calls++
    total.durationMs += row.durationMs
    total.errors += Number(row.status >= 400)
    groups.set(row.function, total)
  }
  const functions = [...groups.values()].sort((a, b) => b.durationMs - a.durationMs)
  return { through: new Date(business).toISOString(), calls: selected.length, spanMs: finished - started,
    durationMs: functions.reduce((sum, row) => sum + row.durationMs, 0),
    errors: functions.reduce((sum, row) => sum + row.errors, 0), functions }
}

export function clockRuntime(load) {
  const patterns = [
    { name: 'transaction', pattern: /^SELECT season_sim\.time\(season_sim\.real_transaction\(\)\)$/ },
    { name: 'wall', pattern: /^SELECT season_sim\.time\(\)$/ },
    { name: 'table', pattern: /FROM season_sim\.clock WHERE singleton/ },
  ]
  const queries = new Map([...(load?.byTotal ?? []), ...(load?.byMean ?? [])].map(row => [row.queryid, row]))
  return patterns.flatMap(({ name, pattern }) => {
    const row = [...queries.values()].find(row => pattern.test(row.query))
    if (!row) return []
    assert.ok(row.calls > 0 && Number.isFinite(row.total_exec_time) && row.total_exec_time >= 0, 'Clock statistics require measured calls and duration')
    return [{ clock: name, calls: row.calls, durationMs: row.total_exec_time, meanMs: row.total_exec_time / row.calls,
      normalized200Ms: 200 * row.total_exec_time / row.calls, rows: row.rows_returned_or_affected,
      buffers: row.shared_blks_hit + row.shared_blks_read }]
  })
}
