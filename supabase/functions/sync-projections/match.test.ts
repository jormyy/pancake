import { buildFantasyProsProjectionPayload, normalizeFantasyProsTeam, type PlayerForProjection } from './match.ts'
import { parseFantasyProsProjectionHtml } from './parser.ts'

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const players: PlayerForProjection[] = [
  { id: '00000000-0000-0000-0000-000000000001', display_name: 'Victor Wembanyama', nba_team: 'SAS', status: 'Active' },
  { id: '00000000-0000-0000-0000-000000000002', display_name: 'Nic Claxton', nba_team: 'BKN', status: 'Active' },
  { id: '00000000-0000-0000-0000-000000000003', display_name: 'Ajay Mitchell', nba_team: 'OKC', status: 'Active' },
  { id: '00000000-0000-0000-0000-000000000004', display_name: 'Duplicate Name', nba_team: 'LAL', status: 'Active' },
  { id: '00000000-0000-0000-0000-000000000005', display_name: 'Duplicate Name', nba_team: 'LAC', status: 'Active' },
]

Deno.test('matches FantasyPros rows by normalized name and team while preserving unmatched rows', async () => {
  const html = await Deno.readTextFile(new URL('./fixtures/fantasypros-daily.html', import.meta.url))
  const parsed = parseFantasyProsProjectionHtml(html)
  const payload = buildFantasyProsProjectionPayload({
    runId: '10000000-0000-0000-0000-000000000000',
    projectionType: 'daily',
    sourceUrl: 'https://www.fantasypros.com/nba/projections/daily-overall.php',
    rows: parsed,
    players,
    fetchedAt: '2026-01-10T14:00:00.000Z',
    seasonYear: 2026,
    weekNumber: 12,
    projectionDate: '2026-01-10',
  })

  expect(payload.rows.length === 4, `expected every source row preserved, got ${payload.rows.length}`)
  expect(payload.matched === 3, `expected 3 matched rows, got ${payload.matched}`)
  expect(payload.unmatched === 1, `expected 1 unmatched row, got ${payload.unmatched}`)

  const claxton = payload.rows.find((row) => row.source_player_name === 'Nicolas Claxton')
  expect(claxton?.player_id === '00000000-0000-0000-0000-000000000002', 'expected alias match to Nic Claxton')
  expect(claxton?.match_reason === 'normalized-name and team match', `unexpected match reason ${claxton?.match_reason}`)

  const freeAgent = payload.rows.find((row) => row.source_player_name === 'Malik Newman')
  expect(freeAgent?.player_id === null, 'expected free-agent source row to remain unmatched')
  expect(freeAgent?.match_status === 'unmatched', `expected unmatched status, got ${freeAgent?.match_status}`)
})

Deno.test('marks duplicate normalized-name matches ambiguous unless team disambiguates', () => {
  const row = parseFantasyProsProjectionHtml(`
    <table id="data">
      <tr><th>Player</th><th>PTS</th><th>REB</th><th>AST</th></tr>
      <tbody>
        <tr><td>Duplicate Name NYK - PG</td><td>1</td><td>1</td><td>1</td></tr>
        <tr><td>Duplicate Name LAC - PG</td><td>1</td><td>1</td><td>1</td></tr>
      </tbody>
    </table>
  `)
  const payload = buildFantasyProsProjectionPayload({
    runId: '10000000-0000-0000-0000-000000000001',
    projectionType: 'daily',
    sourceUrl: 'https://www.fantasypros.com/nba/projections/daily-overall.php',
    rows: row,
    players,
    fetchedAt: '2026-01-10T14:00:00.000Z',
    seasonYear: 2026,
    weekNumber: 12,
    projectionDate: '2026-01-10',
  })

  expect(payload.rows[0].match_status === 'ambiguous', `expected ambiguous, got ${payload.rows[0].match_status}`)
  expect(payload.rows[1].player_id === '00000000-0000-0000-0000-000000000005', 'expected LAC team to disambiguate')
})

Deno.test('normalizes FantasyPros team aliases to Pancake NBA team codes', () => {
  expect(normalizeFantasyProsTeam('GS') === 'GSW', 'expected GS -> GSW')
  expect(normalizeFantasyProsTeam('NO') === 'NOP', 'expected NO -> NOP')
  expect(normalizeFantasyProsTeam('NOR') === 'NOP', 'expected NOR -> NOP')
  expect(normalizeFantasyProsTeam('NY') === 'NYK', 'expected NY -> NYK')
  expect(normalizeFantasyProsTeam('SA') === 'SAS', 'expected SA -> SAS')
  expect(normalizeFantasyProsTeam('FA') === null, 'expected FA -> null')
})
