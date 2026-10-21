import assert from 'node:assert/strict'
import test from 'node:test'
import { postponementTimeline, checkPostponement } from './postponement-oracle.mjs'

const entry = { sourceDate: '2025-01-09', date: '2025-01-09', time: '2025-01-10T03:00:00Z', espnId: 'e', home: 'LAL', away: 'CHA', status: 'STATUS_POSTPONED', notes: [{ headline: 'Makeup date Feb 19' }], source: 'scoreboard-2025-01-09' }
const game = { id: '0022400544', home: 'LAL', away: 'CHA', date: '2025-02-19', time: '2025-02-20T03:00:00Z' }

test('postponement facts and synthetic transition times remain distinct', () => {
  const plan = postponementTimeline([entry], [game])
  assert.equal(plan.timelines[0].originalDate, entry.sourceDate)
  assert.equal(plan.timelines[0].makeupDate, game.date)
  assert.match(plan.timelines[0].facts.transitionTimes, /SYNTHETIC/)
  assert.ok(plan.timelines[0].rescheduledAt>Date.parse('2025-01-13T09:00:00Z'),'Cross-week availability keeps the confirmed postponement through original-week closure')
  assert.equal(postponementTimeline([entry], []).gaps.length, 1)
})

test('postponement check rejects stalled weeks, duplicates, and original-week makeup attribution', () => {
  const timeline = postponementTimeline([entry], [game]).timelines[0]
  const input = { timeline, date: '2025-02-20', calendar: { weeks: [{ week_number: 1, week_start: '2025-01-06', week_end: '2025-01-12' }, { week_number: 2, week_start: '2025-02-10', week_end: '2025-02-23' }] }, originalMatchups: [{ is_finalized: true }], storedGames: [{ nba_game_id: game.id, game_date: game.date, week_number: 2 }], stats: [{ player_id: 'a' }] }
  assert.ok(checkPostponement(input).passed)
  assert.throws(() => checkPostponement({ ...input, originalMatchups: [{ is_finalized: false }] }))
  assert.throws(() => checkPostponement({ ...input, stats: [{ player_id: 'a' }, { player_id: 'a' }] }))
  assert.throws(() => checkPostponement({ ...input, storedGames: [{ ...input.storedGames[0], week_number: 1 }] }))
})
