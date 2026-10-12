import { deepStrictEqual as assertEquals } from 'node:assert'
import type { NBABoxScorePlayer } from './nba.ts'

// This suite calls the row builder only. It has no database or provider traffic.
Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:1')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'local-row-builder-test')
const { buildStatRow } = await import('./syncStats.ts')

function player(played: unknown, minutes: unknown): NBABoxScorePlayer {
  return {
    personId: 1,
    name: 'DNP semantic control',
    played,
    statistics: { minutes, points: 12, reboundsTotal: 10, assists: 10, turnovers: 2 },
  } as unknown as NBABoxScorePlayer
}

const cases: [string, unknown, unknown, boolean, number | null][] = [
  ['provider DNP zero minutes', '0', 'PT00M00.00S', true, 0],
  ['numeric provider DNP', 0, 'PT00M00.00S', true, 0],
  ['provider DNP takes precedence over minutes', '0', 'PT12M30.00S', true, 12.5],
  ['played zero minutes', '1', 'PT00M00.00S', false, 0],
  ['numeric played zero minutes', 1, 'PT00M00.00S', false, 0],
  ['played positive minutes', '1', 'PT12M30.00S', false, 12.5],
  ['played missing minutes', '1', undefined, false, null],
  ['played null minutes', '1', null, false, null],
  ['played invalid minutes', '1', 'invalid', false, null],
  ['absent flag zero minutes', undefined, 'PT00M00.00S', false, 0],
  ['null flag positive minutes', null, 'PT12M30.00S', false, 12.5],
  ['invalid flag positive minutes', 'invalid', 'PT12M30.00S', false, 12.5],
  ['boolean is not provider zero', false, 'PT00M00.00S', false, 0],
  ['empty string is not provider zero', '', 'PT00M00.00S', false, 0],
  ['absent flag missing minutes', undefined, undefined, true, null],
  ['null flag null minutes', null, null, true, null],
  ['invalid flag invalid minutes', 'invalid', 'invalid', true, null],
  ['unparseable numeric duration', undefined, 'PT0M.S', true, null],
  ['non-string duration', undefined, 0, true, null],
]
for (const [label, played, minutes, dnp, parsedMinutes] of cases) {
  Deno.test(label, () => {
    const row = buildStatRow(player(played, minutes), 'player', 'game', 2025, 5)
    assertEquals(row.did_not_play, dnp)
    assertEquals(row.minutes_played, parsedMinutes)
    assertEquals([row.points, row.rebounds, row.assists, row.turnovers], [12, 10, 10, 2])
    assertEquals([row.double_double, row.triple_double], [true, true])
  })
}

Deno.test('a later provider revision can correct participation in either direction', () => {
  const rows = ['0', '1', '0'].map((played) =>
    buildStatRow(player(played, 'PT00M00.00S'), 'player', 'game', 2025, 5)
  )
  assertEquals(rows.map((row) => row.did_not_play), [true, false, true])
  assertEquals(rows.map((row) => row.points), [12, 12, 12])
})
