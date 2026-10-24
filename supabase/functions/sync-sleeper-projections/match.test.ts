import { strict as assert } from 'node:assert'
import { parseSleeperProjections } from './parser.ts'
import { matchSleeperProjections, type SleeperPlayer } from './match.ts'

const fixture = JSON.parse(await Deno.readTextFile(new URL('./fixtures/matched-sample.json', import.meta.url)))
const rows = parseSleeperProjections(fixture, { seasonYear: 2027, sleeperWeek: 1, weekStart: '2026-10-19', weekEnd: '2026-10-25' }).rows
const player = (id: string, sleeper_id: string | null, display_name: string, nba_team: string): SleeperPlayer => ({ id, sleeper_id, display_name, nba_team })

Deno.test('matches IDs before names and uses a unique normalized name plus team for missing IDs', () => {
  const result = matchSleeperProjections(rows, [player('a', '1200', 'Changed Name', 'ATL'), player('b', null, 'LéBron James Jr.', 'PHI')], 2027, 1)
  assert.equal(result.matched, 2)
  assert.equal(result.unmatched, 1)
  assert.equal(result.rows[0].player_id, 'a')
  assert.equal(result.rows[1].player_id, 'b')
  assert.equal(result.rows[0].minutes, 5)
  assert.equal(result.rows[1].field_goals_attempted, 11.02)
})

Deno.test('ambiguous IDs, names, and wrong teams remain unmatched', () => {
  for (const players of [
    [player('a', '1200', 'Mike Conley', 'BOS'), player('b', '1200', 'Other Name', 'ATL')],
    [player('a', null, 'Mike Conley', 'BOS'), player('b', null, 'Mike Conley Jr.', 'BOS')],
    [player('a', null, 'Mike Conley', 'ATL')], [player('a', 'different', 'Mike Conley', 'BOS')],
  ]) assert.equal(matchSleeperProjections([rows[0]], players, 2027, 1).matched, 0)
})

Deno.test('a projected sit matches and stores zeros rather than falling back', () => {
  const sit = parseSleeperProjections([{ ...fixture[0], stats: {} }], { seasonYear: 2027, sleeperWeek: 1, weekStart: '2026-10-19', weekEnd: '2026-10-25' }).rows
  const result = matchSleeperProjections(sit, [player('a', '1200', 'Mike Conley', 'BOS')], 2027, 1)
  assert.equal(result.matched, 1)
  assert.equal(result.rows[0].points, 0)
  assert.equal(result.rows[0].minutes, 0)
  assert.equal(result.rows[0].double_doubles, 0)
  assert.equal(result.rows[0].field_goals_attempted, 0)
})
