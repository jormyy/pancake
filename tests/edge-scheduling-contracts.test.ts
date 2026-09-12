import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

// Wiring contracts for the scheduling fixes; the behaviour itself is covered by
// tests/db/cron-dispatch-catchup.sql, edge-invocation-reconcile.sql,
// live-poll-gate-and-lease.sql and _shared/leaseHeartbeat.test.ts.
describe('scheduling wiring', () => {
    it('live-poll renews its lease with the shared heartbeat and stops it on exit', async () => {
        const source = await readFile('supabase/functions/live-poll/index.ts', 'utf8')
        expect(source).toContain("supabase.rpc('renew_live_poll_lease'")
        expect(source).toMatch(/startLeaseHeartbeat\(/)
        expect(source.indexOf('heartbeat.stop()')).toBeGreaterThan(source.indexOf('} finally {'))
    })

    it('the optimizer visits the least recently optimized members first', async () => {
        const source = await readFile('supabase/functions/lineup-optimizer/index.ts', 'utf8')
        expect(source).toMatch(/\.eq\('enabled', true\)[\s\S]*\.order\('last_optimized_at', \{ ascending: true, nullsFirst: true \}\)/)
    })

    it('the cron job list schedules the invocation reconciler', async () => {
        const migration = await readFile('supabase/migrations/20260912000003_scheduling_catchup_and_durable_invocations.sql', 'utf8')
        expect(migration).toContain("'edge-invocation-reconcile'")
        expect(migration).toContain("SELECT private.reconcile_edge_invocations()")
    })

    it('every ET-time gate goes through the once-per-period claim', async () => {
        for (const fn of ['invoke_edge_function_at_et_time', 'invoke_dynasty_ranking_views_at_et_time', 'invoke_season_boundary_if_due']) {
            const source = await readFile(`supabase/sql/functions/by-name/public/${fn}.sql`, 'utf8')
            expect(source, fn).toContain('private.claim_cron_dispatch(')
            expect(source, fn).not.toMatch(/EXTRACT\(MINUTE FROM v_now\)::int = p_minute/)
        }
    })
})
