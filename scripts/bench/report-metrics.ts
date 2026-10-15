import { tableMetrics } from './metrics.ts'

const [evidence, ...labels] = Deno.args
if (!evidence || labels.length < 2) throw new Error('Pass the evidence directory and full-season labels.')
const results = []
for (const label of labels) {
  const result = JSON.parse(await Deno.readTextFile(`${evidence}/${label}-result.json`))
  const statements = JSON.parse(await Deno.readTextFile(`${evidence}/${label}-statements.json`))
  const tables = JSON.parse(await Deno.readTextFile(`${evidence}/${label}-table-stats.json`))
  const production = statements.filter((row: { query: string }) => !row.query.includes('bench.') && !row.query.includes('pg_stat_force_next_flush'))
  const statementCalls = production.reduce((sum: number, row: { calls: string | number }) => sum + Number(row.calls), 0)
  const predicate = result.side === 'old' ? 'invoke_lineup_optimizer_if_due' : 'invoke_pre_tipoff_optimizer_if_due'
  const actualCronPredicateCalls = production.filter((row: { toplevel: boolean; query: string }) => row.toplevel && row.query.trim() === `SELECT public.${predicate}()`)
    .reduce((sum: number, row: { calls: string | number }) => sum + Number(row.calls), 0)
  if (statementCalls !== result.statements || actualCronPredicateCalls !== result.cronTicks) throw new Error(`Raw SQL counters differ for ${label}.`)
  const corrected = { ...result, ...tableMetrics(tables), actualCronPredicateCalls }
  delete corrected.excludedReads
  delete corrected.excludedWrites
  await Deno.writeTextFile(`${evidence}/${label}-measured-metrics.json`, JSON.stringify(corrected, null, 2))
  results.push(corrected)
}
if (new Set(results.map((result) => result.fixtureRowsWritten)).size !== 1) throw new Error('The measured fixture mutation counts differ between sides.')
const initial = results.find((result) => result.label === 'new-initial')
const candidate = results.find((result) => result.label === 'new-improved')
const sameLineups = initial && candidate ? (await Deno.readTextFile(`${evidence}/new-initial-lineups.json`)) === (await Deno.readTextFile(`${evidence}/new-improved-lineups.json`)) : false
const metrics = ['statements', 'topLevelStatements', 'statementRows', 'tableRowsRead', 'tableRowsWritten', 'productionTableRowsWritten', 'invocations', 'cronTicks', 'wallSeconds']
const decision = initial && candidate ? {
  kept: !initial.smoke && !candidate.smoke && sameLineups && candidate.checkedTipoffs === initial.checkedTipoffs
    && candidate.statements < initial.statements && candidate.productionTableRowsWritten < initial.productionTableRowsWritten
    && metrics.every((metric) => candidate[metric] <= initial[metric]),
  sameLineups,
  statementReduction: initial.statements - candidate.statements,
  productionWriteReduction: initial.productionTableRowsWritten - candidate.productionTableRowsWritten,
  regressions: metrics.filter((key) => candidate[key] > initial[key]).map((metric) => ({ metric, before: initial[metric], after: candidate[metric] })),
} : null
const report = {
  correction: 'The original excludedReads/excludedWrites transaction sums are invalid and discarded. Table reads and writes use saved raw cumulative database counters. Reads include observer reads and fixture updates. Production writes exclude the three fixture-only mutation tables. Production SQL statement counters already exclude observer SQL.',
  results, decision,
}
await Deno.writeTextFile(`${evidence}/metric-audit.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
