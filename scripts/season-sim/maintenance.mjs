import assert from 'node:assert/strict'
import { dispatch } from './dispatch.mjs'
import { sql } from './local-stack.mjs'

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
