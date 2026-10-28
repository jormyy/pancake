import { buildDynastyRankingPayload, type PlayerForRanking } from './match.ts'
import type { RankingRow } from './parser.ts'

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const fetchedAt = '2026-06-30T00:00:00.000Z'

function ranking(overrides: Partial<RankingRow>): RankingRow {
  return {
    rank: 1,
    name: 'Player One',
    team: 'GS',
    positions: ['PG'],
    sourcePlayerId: null,
    age: 21.5,
    rankChange: 0,
    games_played: 50,
    field_goal_pct: 0.5,
    free_throw_pct: 0.8,
    three_pointers_made: 1.5,
    points: 20,
    rebounds: 5,
    assists: 4,
    steals: 1,
    blocks: 0.5,
    turnovers: 2,
    comment: 'source comment',
    ...overrides,
  }
}

function player(overrides: Partial<PlayerForRanking>): PlayerForRanking {
  return {
    id: 'player-1',
    display_name: 'Player One',
    sportsdata_id: null,
    sleeper_id: null,
    nba_id: null,
    nba_team: 'GS',
    status: 'Active',
    ...overrides,
  }
}

Deno.test('builds ranking payload with source rows, normalized teams, and matched player ids', () => {
  const payload = buildDynastyRankingPayload(
    [
      ranking({ rank: 1, name: 'Source Player', team: 'GSW', sourcePlayerId: 'sd-1', positions: ['PG', 'SG'] }),
      ranking({ rank: 2, name: '2026 Draft (Pick 1)', team: 'DRA', sourcePlayerId: 'draft' }),
    ],
    [player({ id: 'matched-player', display_name: 'Different Name', sportsdata_id: 'sd-1', nba_team: 'GS' })],
    fetchedAt,
  )

  expect(payload.rows.length === 2, `expected draft placeholders kept, got ${payload.rows.length}`)
  expect(payload.matched === 1, `expected one match, got ${payload.matched}`)
  expect(payload.rows[0].source === 'hashtagbasketball.com', 'expected source')
  expect(payload.rows[0].source_team === 'GS', `expected normalized team, got ${payload.rows[0].source_team}`)
  expect(payload.rows[0].player_id === 'matched-player', `expected player id, got ${payload.rows[0].player_id}`)
  expect(payload.rows[0].source_positions.join(',') === 'PG,SG', 'expected source positions')
  expect(payload.rows[0].fetched_at === fetchedAt, 'expected fetched timestamp')

  const draft = payload.rows[1]
  expect(draft.source_rank === 2, `expected draft kept at its rank, got ${draft.source_rank}`)
  expect(draft.source_player_name === '2026 Draft (Pick 1)', 'expected draft name preserved')
  expect(draft.player_id === null, `expected draft unmatched, got ${draft.player_id}`)
})

Deno.test('uses aliases and team narrowing for ambiguous name matches', () => {
  const payload = buildDynastyRankingPayload(
    [
      ranking({ rank: 12, name: 'Jacky Cui', team: 'BKN', sourcePlayerId: null }),
      ranking({ rank: 20, name: 'Shared Name', team: 'NYK', sourcePlayerId: null }),
    ],
    [
      player({ id: 'cui', display_name: 'Cui Yongxi', nba_team: null }),
      player({ id: 'wrong-team', display_name: 'Shared Name', nba_team: 'LAL' }),
      player({ id: 'right-team', display_name: 'Shared Name', nba_team: 'NY' }),
    ],
    fetchedAt,
  )

  expect(payload.rows[0].player_id === 'cui', `expected alias match, got ${payload.rows[0].player_id}`)
  expect(payload.rows[1].player_id === 'right-team', `expected team-narrowed match, got ${payload.rows[1].player_id}`)
})

Deno.test('leaves ambiguous equal-scored matches unmatched', () => {
  const payload = buildDynastyRankingPayload(
    [ranking({ name: 'Shared Name', team: 'FA', sourcePlayerId: null })],
    [
      player({ id: 'one', display_name: 'Shared Name', nba_team: null, status: null }),
      player({ id: 'two', display_name: 'Shared Name', nba_team: null, status: null }),
    ],
    fetchedAt,
  )

  expect(payload.matched === 0, `expected no matches, got ${payload.matched}`)
  expect(payload.rows[0].player_id === null, `expected null player id, got ${payload.rows[0].player_id}`)
})
