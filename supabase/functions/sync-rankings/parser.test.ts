import { isDraftPlaceholder, parseDynastyRankingsHtml } from './parser.ts'

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function row({
  rank,
  movement = '<i class="fa fa-arrows-h"></i>',
  movementText = '',
  name,
  sourceId,
  age,
  team,
  positions,
  stats = defaultStats(),
  comment = '',
}: {
  rank: number
  movement?: string
  movementText?: string
  name: string
  sourceId: string
  age: string
  team: string
  positions: string
  stats?: string
  comment?: string
}): string {
  return `
    <tr>
      <td class="dynasty d-none d-md-table-cell col"><span>#${rank}</span><br><span class="small text-muted">${movement} ${movementText}</span></td>
      <td class="dynasty d-none d-md-table-cell col-md-2">${name}<input type="hidden" value="${sourceId}"></td>
      <td class="dynasty d-block d-sm-none col">mobile duplicate</td>
      <td class="dynasty d-none d-md-table-cell col">${age}</td>
      <td class="dynasty d-none d-md-table-cell col">${team}</td>
      <td class="dynasty d-none d-md-table-cell col dyn-pos">${positions}</td>
      <td class="dynasty d-none d-md-table-cell col">
        <div class="table-responsive dyn-statwrap">
          <table class="table table-sm table-bordered table--statistics dyn-statgrid">
            <tbody><tr>${stats}</tr></tbody>
          </table>
        </div>
        <div class="dyn-comment">${comment}</div>
      </td>
    </tr>`
}

function stat(value: string, label: string): string {
  return `<td>${value}<span class="lbl">${label}</span></td>`
}

function defaultStats(): string {
  return [
    stat('64', 'GP'),
    stat('0.512', 'FG%'),
    stat('0.827', 'FT%'),
    stat('1.9', '3PM'),
    stat('25.0', 'PTS'),
    stat('11.5', 'REB'),
    stat('3.1', 'AST'),
    stat('1.0', 'STL'),
    stat('3.1', 'BLK'),
    stat('2.4', 'TO'),
  ].join('')
}

Deno.test('parses Hashtag dynasty rows with stats, movement, comments, and source ids', () => {
  const html = `
    <table class="table table-sm table-bordered table-striped table--statistics">
      <tbody>
        ${row({
          rank: 1,
          name: 'Victor Wembanyama',
          sourceId: '110399',
          age: '22.5',
          team: 'SA',
          positions: 'PF,<wbr>C',
          stats: [
            stat('64', 'GP'),
            stat('0.512', 'FG%'),
            stat('0.827', 'FT%'),
            stat('1.9', '3PM'),
            stat('25.0', 'PTS'),
            stat('11.5', 'REB'),
            stat('3.1', 'AST'),
            stat('1.0', 'STL'),
            stat('3.1', 'BLK'),
            stat('2.4', 'TO'),
          ].join(''),
          comment: 'The buy-low window has shut.',
        })}
        ${row({
          rank: 10,
          movement: '<i class="fa fa-arrow-circle-up"></i>',
          movementText: '2',
          name: 'Scottie Barnes',
          sourceId: '200',
          age: '24.9',
          team: 'TOR',
          positions: 'SG,<wbr>SF,<wbr>PF,<wbr>C',
        })}
        ${row({
          rank: 11,
          movement: '<i class="fa fa-arrow-circle-down"></i>',
          movementText: '1',
          name: 'Jalen Johnson',
          sourceId: '201',
          age: '24.5',
          team: 'ATL',
          positions: 'SF,<wbr>PF',
        })}
      </tbody>
    </table>`

  const rankings = parseDynastyRankingsHtml(html)

  expect(rankings.length === 3, `expected 3 rows, got ${rankings.length}`)
  expect(rankings[0].name === 'Victor Wembanyama', 'expected player name')
  expect(rankings[0].sourcePlayerId === '110399', 'expected source id')
  expect(rankings[0].team === 'SA', 'expected source team')
  expect(rankings[0].positions.join(',') === 'PF,C', `expected positions, got ${rankings[0].positions.join(',')}`)
  expect(rankings[0].age === 22.5, `expected age, got ${rankings[0].age}`)
  expect(rankings[0].games_played === 64, `expected GP, got ${rankings[0].games_played}`)
  expect(rankings[0].field_goal_pct === 0.512, `expected FG%, got ${rankings[0].field_goal_pct}`)
  expect(rankings[0].free_throw_pct === 0.827, `expected FT%, got ${rankings[0].free_throw_pct}`)
  expect(rankings[0].three_pointers_made === 1.9, `expected 3PM, got ${rankings[0].three_pointers_made}`)
  expect(rankings[0].points === 25, `expected PTS, got ${rankings[0].points}`)
  expect(rankings[0].rebounds === 11.5, `expected REB, got ${rankings[0].rebounds}`)
  expect(rankings[0].assists === 3.1, `expected AST, got ${rankings[0].assists}`)
  expect(rankings[0].steals === 1, `expected STL, got ${rankings[0].steals}`)
  expect(rankings[0].blocks === 3.1, `expected BLK, got ${rankings[0].blocks}`)
  expect(rankings[0].turnovers === 2.4, `expected TO, got ${rankings[0].turnovers}`)
  expect(rankings[0].comment === 'The buy-low window has shut.', 'expected comment without stat text')
  expect(rankings[1].rankChange === 2, `expected upward movement, got ${rankings[1].rankChange}`)
  expect(rankings[2].rankChange === -1, `expected downward movement, got ${rankings[2].rankChange}`)
})

Deno.test('dedupes repeated source ids to the best rank and identifies draft placeholders', () => {
  const html = `
    <table class="table table--statistics">
      <tbody>
        ${row({ rank: 30, name: 'Duplicate Player', sourceId: 'dup', age: '21.0', team: 'NY', positions: 'PG' })}
        ${row({ rank: 12, name: 'Duplicate Player', sourceId: 'dup', age: '21.0', team: 'NY', positions: 'PG' })}
        ${row({ rank: 13, name: '2026 Draft (Pick 1)', sourceId: 'draft', age: '', team: 'DRA', positions: '' })}
      </tbody>
    </table>`

  const rankings = parseDynastyRankingsHtml(html)

  expect(rankings.length === 2, `expected duplicate source id collapsed, got ${rankings.length}`)
  expect(rankings[0].rank === 12, `expected best rank retained, got ${rankings[0].rank}`)
  expect(isDraftPlaceholder(rankings[1]), 'expected draft pick placeholder detection')
})

Deno.test('returns no rows when the expected ranking table shape is missing', () => {
  const rankings = parseDynastyRankingsHtml('<table><tr><td>changed markup</td></tr></table>')
  expect(rankings.length === 0, `expected no rows, got ${rankings.length}`)
})

Deno.test('rejects rows missing the stats/comment column', () => {
  const html = `
    <table class="table table--statistics">
      <tbody>
        <tr>
          <td class="dynasty d-none d-md-table-cell col"><span>#1</span></td>
          <td class="dynasty d-none d-md-table-cell col-md-2">Short Row<input type="hidden" value="1"></td>
          <td class="dynasty d-none d-md-table-cell col">22.0</td>
          <td class="dynasty d-none d-md-table-cell col">SA</td>
          <td class="dynasty d-none d-md-table-cell col dyn-pos">PG</td>
        </tr>
      </tbody>
    </table>`
  const rankings = parseDynastyRankingsHtml(html)
  expect(rankings.length === 0, `expected short row rejected, got ${rankings.length}`)
})

Deno.test('rejects rows missing the expected stat grid labels', () => {
  const html = `
    <table class="table table--statistics">
      <tbody>
        ${row({
          rank: 1,
          name: 'Missing Stats',
          sourceId: '1',
          age: '22.0',
          team: 'SA',
          positions: 'PG',
          stats: stat('64', 'GP'),
        })}
      </tbody>
    </table>`
  const rankings = parseDynastyRankingsHtml(html)
  expect(rankings.length === 0, `expected row with incomplete stat labels rejected, got ${rankings.length}`)
})
