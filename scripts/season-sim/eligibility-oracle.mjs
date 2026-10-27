import assert from 'node:assert/strict'

export function withHistoricalEligibility(stats, snapshots) {
  return stats.map(row => {
    const saved = snapshots.get(row.lineup_date)
    assert.ok(saved, `Historical eligibility exists for ${row.lineup_date}`)
    assert.ok(Date.parse(saved.observedAt) < Date.parse(row.game_time), 'Historical eligibility is captured before game tipoff')
    const eligibility = saved.players.get(row.player_id)
    assert.ok(eligibility, `Historical eligibility is retained for ${row.player_id} on ${row.lineup_date}`)
    return { ...row, position: eligibility.position, eligible_positions: eligibility.eligible_positions }
  })
}
