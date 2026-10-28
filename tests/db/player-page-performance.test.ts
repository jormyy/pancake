import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { assertIdenticalSnapshots } from './player-page-performance.mjs'

type Evidence = {
    plans: Record<string, Record<string, { 'Execution Time': number }[]>>
    snapshots: Record<string, Record<string, unknown>>
    summaries: Record<string, Record<string, { p95: number }>>
}

const evidencePath = process.env.PLAYER_PAGE_EVIDENCE
const evidence = evidencePath ? JSON.parse(readFileSync(evidencePath, 'utf8')) as Evidence : undefined
const functions = ['view_player', 'view_player_full', 'get_league_projection_rows', 'get_dynasty_forecast_inputs', 'view_home']

it.skipIf(!evidence).each(functions)('records 20 warm executions of %s', name => {
    for (const plans of Object.values(evidence!.plans)) {
        expect(plans[name]).toHaveLength(20)
        expect(plans[name].every(plan => plan['Execution Time'] > 0)).toBe(true)
    }
})

it.skipIf(!evidence?.snapshots.after).each(Object.keys(evidence?.snapshots.before ?? {}))('preserves the complete %s JSON snapshot', name => {
    assertIdenticalSnapshots(evidence!.snapshots.before[name], evidence!.snapshots.after[name])
})

it('rejects changed snapshot values, shapes, and array order', () => {
    const before = { points: 25, games: ['home', 'away'] }
    for (const after of [{ ...before, points: 26 }, { ...before, extra: null }, { ...before, games: ['away', 'home'] }]) {
        expect(() => assertIdenticalSnapshots(before, after)).toThrow('Screen JSON must remain identical')
    }
})

it.skipIf(!evidence?.snapshots.after)('meets the player, home, and projection latency targets', () => {
    const after = evidence!.summaries.after
    expect(after.view_player.p95).toBeLessThan(300)
    expect(after.view_player_full.p95).toBeLessThan(300)
    expect(after.view_home.p95).toBeLessThan(300)
    expect(after.get_league_projection_rows.p95).toBeLessThan(500)
    expect(after.get_dynasty_forecast_inputs.p95).toBeLessThan(evidence!.summaries.before.get_dynasty_forecast_inputs.p95)
})
