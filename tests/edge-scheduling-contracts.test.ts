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

    it('scheduled optimization loads eligible settings through the paginated loader', async () => {
        const source = await readFile('supabase/functions/lineup-optimizer/index.ts', 'utf8')
        expect(source).toContain("import { loadEnabledOptimizerSettings, type OptimizerSetting } from './settings.ts'")
        expect(source).toContain('await loadEnabledOptimizerSettings(supabase, [...new Set(dateContexts.map((context) => context.seasonYear))])')
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

    it('score sync certifies inputs and SQL owns playoff grace resets', async () => {
        for (const file of ['supabase/shared-src/sync/scores.ts', 'supabase/functions/_shared/syncScores.ts']) {
            const source = await readFile(file, 'utf8')
            expect(source, file).toContain('score_read_started_at: scoringReadStartedAt')
            expect(source, file).toContain("supabase.rpc('capture_score_inputs'")
            expect(source, file).toContain('input_token: inputToken,')
        }
        const sql = await readFile('supabase/sql/functions/by-name/public/finalize_score_week_atomic.sql', 'utf8')
        expect(sql).toContain('private.lock_current_score_inputs(p_league_season_id, p_week_number, v_input_token)')
        expect(sql).toContain('locked.winner_member_id IS DISTINCT FROM locked.requested_winner_member_id')
        expect(sql).toContain('locked.home_max_possible_points IS DISTINCT FROM locked.requested_home_max_possible_points')
        expect(sql).toContain('locked.away_max_possible_points IS DISTINCT FROM locked.requested_away_max_possible_points')
        expect(sql).not.toContain('COALESCE(locked.requested_reconcile_decision, true) THEN p_reconciliation_at')
    })
})
