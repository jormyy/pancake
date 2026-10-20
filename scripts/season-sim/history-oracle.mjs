import assert from 'node:assert/strict'

export function checkSeasonHistory(before, after, priorities) {
  const metadataChanges = []
  for (const table of ['matchups', 'standings']) {
    assert.ok(before[table].length > 0, 'Season history must contain expected rows')
    assert.equal(after[table].length, before[table].length, `Rollover preserves ${table} row count`)
    for (const row of before[table]) {
      const current = after[table].find(value => value.id === row.id)
      assert.ok(current, `Rollover preserves ${table} row ${row.id}`)
      const fields = table === 'matchups' ? ['score_read_started_at'] : ['created_at', 'waiver_priority']
      for (const field of fields) {
        if (row[field] === current[field]) continue
        if (field === 'waiver_priority') assert.equal(current[field], priorities?.[row.member_id], 'Refreshed standings priority follows independent waiver outcomes')
        metadataChanges.push({ table, id: row.id, field, before: row[field], after: current[field] })
      }
      const stable = value => Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)))
      assert.deepEqual(stable(current), stable(row), `Rollover preserves ${table} results ${row.id}`)
    }
  }
  return { passed: true, matchups: before.matchups.length, standings: before.standings.length, metadataChanges }
}
