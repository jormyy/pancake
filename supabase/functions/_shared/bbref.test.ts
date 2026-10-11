import { fetchBBRefBoxScore } from './bbref.ts'

const columns: Record<string, number> = {
  pts: 12, trb: 4, orb: 1, drb: 3, ast: 2, stl: 1, blk: 0, tov: 1,
  pf: 2, fg: 5, fga: 9, fg3: 1, fg3a: 3, ft: 1, fta: 2, plus_minus: 3,
}
const cells = (multiplier = 1) => Object.entries(columns)
  .map(([key, value]) => `<td data-stat="${key}">${value * multiplier}</td>`).join('')
const row = (index: number, minutes = '40:00') => `<tr><th data-stat="player">Synthetic ${index}</th>` +
  `<td data-stat="mp">${minutes}</td>${cells()}</tr>`
const totals = `<tr><th data-stat="player">Team Totals</th><td data-stat="mp">240</td>${cells(6)}</tr>`
const team = (code: string, rows = Array.from({ length: 6 }, (_, i) => row(i)).join(''), footer = totals) =>
  `<table id="box-${code}-game-basic"><tbody>${rows}</tbody><tfoot>${footer}</tfoot></table>`
const page = (home = team('BOS')) => home + team('NYK')

async function parse(html: string) {
  const original = globalThis.fetch
  globalThis.fetch = () => Promise.resolve(new Response(html))
  try { return await fetchBBRefBoxScore('202610010BOS', 'BOS', 'NYK') }
  finally { globalThis.fetch = original }
}
async function rejects(html: string, match: RegExp) {
  try { await parse(html) }
  catch (error) {
    if (error instanceof Error && match.test(error.message)) return
    throw error
  }
  throw new Error('Invalid box score was accepted')
}

Deno.test('BBRef uses provider totals to reject omitted players before a first import', async () => {
  const healthy = await parse(page())
  if (healthy.home.length !== 6 || healthy.away.length !== 6) throw new Error('Complete rows were lost')
  await rejects(page(team('BOS', Array.from({ length: 5 }, (_, i) => row(i)).join(''))), /team total pts/)
})

Deno.test('BBRef requires unambiguous complete totals and accepts body totals fallback', async () => {
  await rejects(page(team('BOS', row(0), '')), /team totals missing/)
  await rejects(page(team('BOS', row(0), totals + totals)), /team totals missing or ambiguous/)
  await rejects(page(team('BOS', undefined, totals.replace('<td data-stat="ast">12</td>', ''))), /team total ast/)
  const bodyTotal = team('BOS').replace(`<tfoot>${totals}</tfoot>`, '').replace('</tbody>', `${totals}</tbody>`)
  const parsed = await parse(page(bodyTotal))
  if (parsed.home.length !== 6) throw new Error('Totals were parsed as a player')
})

Deno.test('BBRef rejects malformed minute tokens even when their numeric prefixes match totals', async () => {
  for (const value of ['40garbage:00', '40:00garbage', '40:60', '40:99', '-40:00', '40:-1', '40:1', '40:00:00', '', 'NaN:00']) {
    await rejects(page(team('BOS', row(0, value) + Array.from({ length: 5 }, (_, i) => row(i + 1)).join(''))), /Malformed BBRef minutes/)
  }
})

Deno.test('BBRef compares clock totals at their displayed precision without fixed game length', async () => {
  const otherRows = Array.from({ length: 5 }, (_, i) => row(i + 1)).join('')
  const rounded = await parse(page(team('BOS', row(0, '39:59') + otherRows)))
  if (rounded.home.length !== 6) throw new Error('Displayed rounding rejected complete rows')
  await rejects(page(team('BOS', row(0, '20:00') + otherRows)), /team total minutes/)
  await rejects(page(team('BOS', undefined, totals.replace('>240</td>', '>240garbage</td>'))), /team total minutes/)
  const overtime = await parse(page(team('BOS', row(0, '45:00') + otherRows, totals.replace('>240</td>', '>245</td>'))))
  if (overtime.home[0].minutesDecimal !== 45) throw new Error('Provider duration did not survive')
})

Deno.test('BBRef rejects omitted short appearances without equating team and player turnovers', async () => {
  const shortValues = Object.fromEntries(Object.keys(columns).map((key) => [key, 0]))
  Object.assign(shortValues, { trb: 1, drb: 1, tov: 1 })
  const short = `<tr><th data-stat="player">Short appearance</th><td data-stat="mp">0:10</td>` +
    Object.entries(shortValues).map(([key, value]) => `<td data-stat="${key}">${value}</td>`).join('') + '</tr>'
  const regulars = row(0, '39:50') + Array.from({ length: 5 }, (_, i) => row(i + 1)).join('')
  const fullTotals = totals.replace('data-stat="trb">24', 'data-stat="trb">25')
    .replace('data-stat="drb">18', 'data-stat="drb">19').replace('data-stat="tov">6', 'data-stat="tov">8')
  const complete = await parse(page(team('BOS', regulars + short, fullTotals)))
  if (complete.home.length !== 7 || complete.home.reduce((sum, player) => sum + player.tov, 0) !== 7) {
    throw new Error('Team turnover was assigned to a player or a player was lost')
  }
  await rejects(page(team('BOS', regulars, fullTotals)), /team total (trb|drb|minutes)/)
  // Independent clock control has no rebound mismatch and includes an unassigned team turnover.
  await rejects(page(team('BOS', regulars, totals.replace('data-stat="tov">6', 'data-stat="tov">7'))), /team total minutes/)
  // One missing second can fall within clock precision, but a scoring rebound cannot.
  await rejects(page(team('BOS', row(0, '39:59') + Array.from({ length: 5 }, (_, i) => row(i + 1)).join(''), fullTotals)), /team total (trb|drb)/)
})

Deno.test('BBRef rejects player counts outside the inclusive team turnover total', async () => {
  const rest = Array.from({ length: 5 }, (_, i) => row(i + 1)).join('')
  await rejects(page(team('BOS', row(0).replace('data-stat="tov">1', 'data-stat="tov">100') + rest)), /team total tov/)
  for (const invalid of ['', '-1', '8garbage', '9007199254740993']) {
    await rejects(page(team('BOS', undefined, totals.replace('data-stat="tov">6', `data-stat="tov">${invalid}`))), /team total tov/)
  }
})

Deno.test('BBRef rejects negative counting values while preserving signed plus-minus', async () => {
  const rest = Array.from({ length: 5 }, (_, i) => row(i + 1)).join('')
  const offsetting = row(0).replace('data-stat="pts">12', 'data-stat="pts">-12') +
    row(1).replace('data-stat="pts">12', 'data-stat="pts">36') +
    Array.from({ length: 4 }, (_, i) => row(i + 2)).join('')
  await rejects(page(team('BOS', offsetting)), /Malformed BBRef stat pts/)
  await rejects(page(team('BOS', row(0).replace('data-stat="pts">12', 'data-stat="pts">9007199254740993') + rest)), /Malformed BBRef stat pts/)
  for (const column of ['pts', 'trb', 'orb', 'drb', 'ast', 'stl', 'blk', 'tov', 'pf', 'fg', 'fga', 'fg3', 'fg3a', 'ft', 'fta']) {
    const negative = row(0).replace(new RegExp(`data-stat="${column}">[0-9]+`), `data-stat="${column}">-1`)
    await rejects(page(team('BOS', negative + rest)), /Malformed BBRef stat/)
  }
  const parsed = await parse(page(team('BOS', row(0).replace('data-stat="plus_minus">3', 'data-stat="plus_minus">-3') + rest)))
  if (parsed.home[0].plusMinus !== -3) throw new Error('Signed plus/minus was rejected')
})
