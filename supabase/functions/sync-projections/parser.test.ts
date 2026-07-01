import { parseFantasyProsPlayerCell, parseFantasyProsProjectionHtml } from './parser.ts'

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

Deno.test('parses FantasyPros projection table rows from a saved HTML fixture', async () => {
  const html = await Deno.readTextFile(new URL('./fixtures/fantasypros-daily.html', import.meta.url))
  const rows = parseFantasyProsProjectionHtml(html)

  expect(rows.length === 4, `expected 4 projection rows, got ${rows.length}`)
  expect(rows[0].name === 'Victor Wembanyama', 'expected linked player name')
  expect(rows[0].team === 'SAS', `expected SAS team, got ${rows[0].team}`)
  expect(rows[0].positions.join(',') === 'PF,C', `expected PF,C positions, got ${rows[0].positions.join(',')}`)
  expect(rows[0].opponent === 'vs BOS', `expected opponent, got ${rows[0].opponent}`)
  expect(rows[0].points === 28.5, `expected PTS, got ${rows[0].points}`)
  expect(rows[0].rebounds === 11.2, `expected REB, got ${rows[0].rebounds}`)
  expect(rows[0].assists === 4.1, `expected AST, got ${rows[0].assists}`)
  expect(rows[0].blocks === 3.7, `expected BLK, got ${rows[0].blocks}`)
  expect(rows[0].steals === 1.1, `expected STL, got ${rows[0].steals}`)
  expect(rows[0].field_goal_pct === 52.3, `expected FG%, got ${rows[0].field_goal_pct}`)
  expect(rows[0].free_throw_pct === 82.5, `expected FT%, got ${rows[0].free_throw_pct}`)
  expect(rows[0].three_pointers_made === 2.1, `expected 3PM, got ${rows[0].three_pointers_made}`)
  expect(rows[0].games_played === 1, `expected GP, got ${rows[0].games_played}`)
  expect(rows[0].minutes === 34.5, `expected MIN, got ${rows[0].minutes}`)
  expect(rows[0].turnovers === 2.8, `expected TO, got ${rows[0].turnovers}`)
})

Deno.test('parses player-cell variants including aliases, status suffixes, free agents, punctuation, and rookies', () => {
  const gtd = parseFantasyProsPlayerCell('<td><a>Nicolas Claxton</a> BKN - C GTD</td>')
  expect(gtd.name === 'Nicolas Claxton', `expected name, got ${gtd.name}`)
  expect(gtd.team === 'BKN', `expected BKN, got ${gtd.team}`)
  expect(gtd.status === 'GTD', `expected GTD, got ${gtd.status}`)

  const rookie = parseFantasyProsPlayerCell('<td>Ajay Mitchell OKC - PG,SG</td>')
  expect(rookie.name === 'Ajay Mitchell', `expected rookie name, got ${rookie.name}`)
  expect(rookie.positions.join(',') === 'PG,SG', `expected PG,SG, got ${rookie.positions.join(',')}`)

  const punctuated = parseFantasyProsPlayerCell("<td><a>Dereck Lively II</a> DAL - C</td>")
  expect(punctuated.name === 'Dereck Lively II', `expected suffix name, got ${punctuated.name}`)
  expect(punctuated.positions.join(',') === 'C', `expected C, got ${punctuated.positions.join(',')}`)

  const freeAgent = parseFantasyProsPlayerCell('<td><a>Malik Newman</a> FA - SG Out</td>')
  expect(freeAgent.team === 'FA', `expected FA, got ${freeAgent.team}`)
  expect(freeAgent.status === 'Out', `expected Out, got ${freeAgent.status}`)

  const parenthesized = parseFantasyProsPlayerCell('<td><a>Tyrese Maxey</a> (PHI - PG)</td>')
  expect(parenthesized.team === 'PHI', `expected PHI, got ${parenthesized.team}`)
  expect(parenthesized.positions.join(',') === 'PG', `expected PG, got ${parenthesized.positions.join(',')}`)

  const parenthesizedStatus = parseFantasyProsPlayerCell('<td><a>Brandon Ingram</a> (LAC - SG,SF,PF) OUT</td>')
  expect(parenthesizedStatus.team === 'LAC', `expected LAC, got ${parenthesizedStatus.team}`)
  expect(
    parenthesizedStatus.positions.join(',') === 'SG,SF,PF',
    `expected SG,SF,PF, got ${parenthesizedStatus.positions.join(',')}`,
  )
  expect(parenthesizedStatus.status === 'Out', `expected Out, got ${parenthesizedStatus.status}`)

  const unlinkedParenthesized = parseFantasyProsPlayerCell('<td>Tre Jones (CHI - PG,SG) Q</td>')
  expect(unlinkedParenthesized.name === 'Tre Jones', `expected Tre Jones, got ${unlinkedParenthesized.name}`)
  expect(unlinkedParenthesized.team === 'CHI', `expected CHI, got ${unlinkedParenthesized.team}`)
  expect(unlinkedParenthesized.status === 'Questionable', `expected Questionable, got ${unlinkedParenthesized.status}`)
})

Deno.test('returns no rows when projections are unavailable or table shape changes', () => {
  const unavailable = parseFantasyProsProjectionHtml(`
    <table id="data"><tr><th>Player</th><th>PTS</th><th>REB</th></tr>
      <tbody><tr><td colspan="13">Projections are not available yet.</td></tr></tbody>
    </table>
  `)
  expect(unavailable.length === 0, `expected no rows, got ${unavailable.length}`)

  const changed = parseFantasyProsProjectionHtml('<table><tr><th>Name</th><th>Score</th></tr><tr><td>A</td><td>1</td></tr></table>')
  expect(changed.length === 0, `expected changed shape to parse no rows, got ${changed.length}`)
})
