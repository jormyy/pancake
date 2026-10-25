import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureRegularSchedule } from './schedule.mjs'

const schedule = [
  { id: 'a', week_number: 1, home_member_id: 'home', away_member_id: 'away', home_points: 7 },
  { id: 'b', week_number: 2, home_member_id: 'away', away_member_id: 'home', home_points: 0 },
]

function context(before, after, result = { ok: true, skipped: true }) {
  let called = false
  return {
    leagueId: 'league', leagueSeasonId: 'season', users: ['commissioner'],
    api: async (user, route, body) => {
      assert.equal(user, 'commissioner')
      assert.equal(route, '/sync/matchups')
      assert.deepEqual(body, { leagueId: 'league' })
      called = true
      return result
    },
    rest: async (user, query) => {
      assert.equal(user, 'commissioner')
      assert.equal(query, 'matchups?select=*&league_id=eq.league&league_season_id=eq.season&order=id')
      return structuredClone(called ? after : before)
    },
  }
}

test('generation accepts a successful skipped response and preserves the existing schedule', async () => {
  assert.deepEqual(await ensureRegularSchedule(context(schedule, schedule)), { ok: true, skipped: true })
})

test('generation rejects a skipped response that replaces or changes schedule rows', async () => {
  for (const change of [{ id: 'replacement' }, { home_points: 0 }, { home_member_id: 'other' }]) {
    await assert.rejects(ensureRegularSchedule(context(schedule, [{ ...schedule[0], ...change }, schedule[1]])), /Existing schedule stays unchanged/)
  }
})

test('generation allows a new schedule when none exists', async () => {
  assert.deepEqual(await ensureRegularSchedule(context([], schedule, { ok: true, skipped: false })), { ok: true, skipped: false })
})
