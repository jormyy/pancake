import assert from 'node:assert/strict'

export function assertEquivalent(before, after) {
  assert.deepEqual(after.values, before.values, 'Returned values changed')
  assert.deepEqual(after.rows, before.rows, 'Touched table row diff changed')
  assert.deepEqual(after.followup, before.followup, 'Follow-up work changed')
  assert.ok(after.freshness >= before.freshness, 'Live score freshness regressed')
}

export function comparePairs(samples) {
  const before = samples.filter(row => row.phase === 'baseline')
  const after = samples.filter(row => row.phase === 'candidate')
  assert.ok(before.length >= 5 && before.length === after.length, 'Five interleaved pairs are required')
  assert.equal(new Set(before.map(row => row.round)).size, before.length)
  for (const row of before) assert.ok(after.some(other => other.round === row.round), 'Pair missing')
  const mean = rows => rows.reduce((sum, row) => sum + row.ms, 0) / rows.length
  const baseline = mean(before), candidate = mean(after)
  const noise = Math.max(Math.max(...before.map(row => row.ms)) - Math.min(...before.map(row => row.ms)), baseline * 0.1)
  return { baseline, candidate, noise, gain: baseline - candidate, keep: baseline - candidate > noise }
}
