import assert from 'node:assert/strict'
import { dispatch } from './dispatch.mjs'
import { sql } from './local-stack.mjs'
import { nextWaiverRun } from './waiver-scenarios.mjs'

export async function maintenanceTick(invoke = dispatch, execute = sql) {
  await execute('SELECT private.reconcile_edge_invocations()')
  await invoke("SELECT public.invoke_edge_function_at_et_time('process-waivers',3,0)", { optional: true })
  const outcomes = await invoke('SELECT public.invoke_season_boundary_if_due()', { optional: true, allowFailure: true })
  for (const result of outcomes) {
    if (result.status_code === 200 && result.worker_status === 'success') continue
    const content = JSON.parse(result.content ?? 'null')
    const errors = content?.leagues?.filter(league => league.error) ?? []
    assert.ok(result.status_code === 200 && result.worker_status === 'failed' && errors.length > 0 && errors.every(league => league.error === 'Resolve pending waiver claims and waiver holds before advancing season.'), `unexpected maintenance failure: ${JSON.stringify(result)}`)
  }
  return outcomes
}

export async function waitForRollover({ start, deadline, oldSeason, move, tick, current }) {
  assert.ok(Number.isFinite(start) && deadline > start)
  let ticks = 0
  for (let at = (Math.floor(start / 900000) + 1) * 900000; at <= deadline; at += 900000) {
    await move(new Date(at).toISOString())
    const outcomes = await tick()
    ticks++
    const season = await current()
    assert.ok(season, 'Rollover read returned no current season')
    if (season !== oldSeason) return { season, ticks, at: new Date(at).toISOString(), outcomes }
  }
  throw new Error(`Season did not roll over within ${ticks} ticks (${new Date(start).toISOString()} to ${new Date(deadline).toISOString()})`)
}

function waiverSettlementAt(scenario) {
  const conditionalDrop = scenario.input.claims.some(claim => claim.drop && scenario.expected.claims[claim.id] === 'succeeded')
  const dropExpiry = conditionalDrop ? nextWaiverRun(scenario.processAt + 48 * 3600000 + 1) : 0
  return Math.max(scenario.processAt, dropExpiry, ...scenario.targets.map(row => row.clearsAt))
}

export function rolloverDeadline(start, ready, scenarios = []) {
  return Math.max(start, ready, ...scenarios.map(waiverSettlementAt)) + 26 * 3600000
}

export function waiverBoundaryDeferral(outcome, context, at) {
  const scenario = context?.waiverScenarios?.find(row => row.name === 'postseason-pending')
  if (outcome.function_name !== 'season-boundary' || outcome.status_code !== 200 || outcome.worker_status !== 'failed' || !scenario || at > waiverSettlementAt(scenario) + 26 * 3600000) return false
  const errors = JSON.parse(outcome.content ?? 'null')?.leagues?.filter(row => row.error) ?? []
  return errors.length > 0 && errors.every(row => row.leagueId === context.leagueId && row.error === 'Resolve pending waiver claims and waiver holds before advancing season.')
}
