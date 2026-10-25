import assert from 'node:assert/strict'

export async function ensureRegularSchedule(context) {
  const query = `matchups?select=*&league_id=eq.${context.leagueId}&league_season_id=eq.${context.leagueSeasonId}&order=id`
  const before = await context.rest(context.users[0], query)
  const result = await context.api(context.users[0], '/sync/matchups', { leagueId: context.leagueId })
  if (before.length) {
    const after = await context.rest(context.users[0], query)
    assert.deepEqual(after, before, 'Existing schedule stays unchanged after non-force generation')
  }
  return result
}
