export function screenBaseline(surfaces, observations) {
  const latest = new Map()
  for (const row of observations) {
    if (!row.webkit?.passed || !['cold', 'warm', 'offline'].includes(row.state)) continue
    const proof = row.webkit
    if (![proof.requests, proof.bytesIn, proof.bytesOut, proof.firstContentMs, proof.settledMs].every(Number.isFinite)) continue
    latest.set(`${row.surface}/${row.state}`, { case: row.id, source: row.source, evidence: row.evidence, role: row.role, day: row.day, requests: proof.requests, bytesDown: proof.bytesIn, bytesUp: proof.bytesOut, firstPaintMs: proof.firstContentMs, settledMs: proof.settledMs })
  }
  return surfaces.filter(surface => !surface.scenario).map(surface => {
    const states = Object.fromEntries(['cold', 'warm', 'offline'].map(state => [state, latest.get(`${surface.id}/${state}`) ?? null]))
    return { surface: surface.id, route: surface.route, states, complete: Object.values(states).every(Boolean), costTimesFrequencyBytes: Object.values(states).reduce((sum, row) => sum + (row?.bytesDown ?? 0), 0) }
  }).sort((a, b) => b.costTimesFrequencyBytes - a.costTimesFrequencyBytes || a.surface.localeCompare(b.surface))
}

export function screenBaselineLines(rows) {
  const metric = row => row ? `${row.requests} / ${row.bytesDown} / ${row.bytesUp} / ${row.firstPaintMs.toFixed(0)} / ${row.settledMs.toFixed(0)}` : 'unmeasured'
  const evidence = row => row ? `${row.case}: ${row.source?.slice(0, 8) ?? 'unknown'}; ${row.evidence ?? 'missing evidence'}` : 'unmeasured'
  return ['## Final ranked screen baseline', '',
    'Each cell lists requests / down bytes / up bytes / first-paint ms / settled ms.',
    'First-paint time is the first matching content frame recorded by the walk.',
    'Cost × frequency sums one captured cold, warm and offline visit. It does not estimate daily traffic.',
    'Each state uses its latest successful measured sample. Source, role and day can differ; this is not a matched performance comparison.', '',
    '| Screen | Cold | Warm | Offline | Cost × frequency bytes |', '| --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.route} (${row.surface}) | ${metric(row.states.cold)} | ${metric(row.states.warm)} | ${metric(row.states.offline)} | ${row.costTimesFrequencyBytes} |`), '',
    '| Screen | Cold evidence | Warm evidence | Offline evidence |', '| --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.surface} | ${evidence(row.states.cold)} | ${evidence(row.states.warm)} | ${evidence(row.states.offline)} |`), '']
}
