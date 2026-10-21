import assert from 'node:assert/strict'
import test from 'node:test'
import { checkIdentityGame, checkContinuity } from './identity-oracle.mjs'

const input = { expected: { nbaId: '1', name: 'Real Rookie', draftPlayerId: 'draft-row', gameId: 'g', date: '2025-10-28', owner: 'a', starter: true, raw: { statistics: { points: 12, assists: 3 } } }, players: [{ id: 'draft-row', nba_id: '1', display_name: 'Real Rookie' }], stats: [{ player_id: 'draft-row', nba_game_id: 'g' }], fantasy: [{ player_id: 'draft-row', nba_game_id: 'g', fantasy_points: 18 }], lineups: [{ player_id: 'draft-row', member_id: 'a', game_date: '2025-10-28', slot_type: 'UTIL' }], settings: { points: 1, assists: 2 } }

test('rookie games fail for duplicates, missing ingestion, lost links, wrong points, or missing starters', () => {
  assert.ok(checkIdentityGame(input).passed)
  assert.throws(() => checkIdentityGame({ ...input, players: [...input.players, { id: 'orphan', nba_id: null, display_name: 'Real Rookie' }] }))
  assert.throws(() => checkIdentityGame({ ...input, stats: [] }))
  assert.throws(() => checkIdentityGame({ ...input, expected: { ...input.expected, draftPlayerId: 'new-row' } }))
  assert.throws(() => checkIdentityGame({ ...input, fantasy: [{ ...input.fantasy[0], fantasy_points: 0 }] }))
  assert.throws(() => checkIdentityGame({ ...input, lineups: [] }))
  assert.ok(checkIdentityGame({ ...input, expected: { ...input.expected, starter: false }, lineups: [{ ...input.lineups[0], slot_type: 'BE' }] }).passed)
})

test('NBA team changes cannot change fantasy identity or owner and must retain later games', () => {
  const expected = { nbaId: '1', playerId: 'draft-row', owner: 'a' }, roster = [{ player_id: 'draft-row', member_id: 'a' }]
  assert.ok(checkContinuity(expected, input.players, roster, 1).passed)
  assert.throws(() => checkContinuity(expected, input.players, [{ ...roster[0], member_id: 'b' }], 1))
  assert.throws(() => checkContinuity(expected, input.players, roster, 0))
  assert.ok(checkContinuity({...expected,to:'CLE'},[{...input.players[0],nba_team:'CLE'}],roster,1).passed)
  assert.throws(()=>checkContinuity({...expected,to:'CLE'},[{...input.players[0],nba_team:'LAC'}],roster,1))
})
