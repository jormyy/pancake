import { changedStatRows } from './syncStats.ts'

const PLAYER_A = '00000000-0000-4000-8000-00000000000a'
const PLAYER_B = '00000000-0000-4000-8000-00000000000b'
const GAME = '00000000-0000-4000-8000-0000000000ff'

function row(playerId: string, overrides: Record<string, unknown> = {}) {
  return {
    player_id: playerId,
    game_id: GAME,
    season_year: 2026,
    week_number: 3,
    minutes_played: 30,
    points: 20,
    rebounds: 5,
    offensive_rebounds: 1,
    defensive_rebounds: 4,
    assists: 4,
    steals: 1,
    blocks: 0,
    turnovers: 2,
    personal_fouls: 3,
    field_goals_made: 8,
    field_goals_attempted: 15,
    three_pointers_made: 2,
    three_pointers_attempted: 5,
    free_throws_made: 2,
    free_throws_attempted: 2,
    plus_minus: 7,
    double_double: false,
    triple_double: false,
    did_not_play: false,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

Deno.test('an unchanged box score produces no writes', () => {
  const built = [row(PLAYER_A), row(PLAYER_B)]
  // Stored rows carry a different updated_at, which must not count as a change:
  // updated_at is how stat corrections are detected downstream, so rewriting it
  // on every re-sync would make each poll look like a correction.
  const stored = [
    row(PLAYER_A, { updated_at: '2026-01-05T12:00:00.000Z' }),
    row(PLAYER_B, { updated_at: '2026-01-05T12:00:00.000Z' }),
  ]
  const changed = changedStatRows(built, stored)
  if (changed.length !== 0) {
    throw new Error(`expected no changed rows, got ${JSON.stringify(changed)}`)
  }
})

Deno.test('a real stat correction is still written', () => {
  const built = [row(PLAYER_A, { points: 22 }), row(PLAYER_B)]
  const stored = [row(PLAYER_A), row(PLAYER_B)]
  const changed = changedStatRows(built, stored)
  if (changed.length !== 1 || changed[0].player_id !== PLAYER_A) {
    throw new Error(`expected only player A to change, got ${JSON.stringify(changed)}`)
  }
})

Deno.test('numeric formatting differences do not count as changes', () => {
  // Postgres returns numerics as strings, e.g. plus_minus "7.0" for 7.
  const built = [row(PLAYER_A)]
  const stored = [row(PLAYER_A, { plus_minus: '7.0', minutes_played: '30' })]
  if (changedStatRows(built, stored).length !== 0) {
    throw new Error('numeric formatting should not be treated as a change')
  }
})

Deno.test('a player with no stored row is written', () => {
  const changed = changedStatRows([row(PLAYER_A)], [])
  if (changed.length !== 1) {
    throw new Error(`expected the new row to be written, got ${JSON.stringify(changed)}`)
  }
})

Deno.test('null and zero are distinguished', () => {
  const built = [row(PLAYER_A, { turnovers: 0 })]
  const stored = [row(PLAYER_A, { turnovers: null })]
  if (changedStatRows(built, stored).length !== 1) {
    throw new Error('a null-to-zero transition must be written')
  }
})

Deno.test('a did_not_play flip is written', () => {
  const built = [row(PLAYER_A, { did_not_play: true, minutes_played: null })]
  const stored = [row(PLAYER_A)]
  if (changedStatRows(built, stored).length !== 1) {
    throw new Error('a DNP transition must be written')
  }
})
