import { describe, expect, it } from 'vitest'
import {
    functionPrivilegeStatements,
    latestCronScheduleStatement,
    latestFunctionDefinition,
    latestPolicyDefinition,
    read,
    tablePrivilegeStatements,
} from './source-guard'

const migration = read('supabase/migrations/20260701000002_fantasypros_projection_source.sql')
const syncProjectionSource = read('supabase/functions/sync-projections/index.ts')
const parserSource = read('supabase/functions/sync-projections/parser.ts')
const matchSource = read('supabase/functions/sync-projections/match.ts')
const lineupOptimizerSource = read('supabase/functions/lineup-optimizer/index.ts')
const autoSetSource = read('lib/lineup/autoSet.ts')
const projectionsScreen = read('app/(tabs)/projections.tsx')
const playerItem = read('components/PlayerSearchItem.tsx')
const playerDetail = read('app/player/[id].tsx')

describe('FantasyPros projection source implementation', () => {
    it('stores auditable source runs and raw rows, including unmatched rows', () => {
        expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.projection_sync_runs')
        expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.fantasypros_projection_rows')
        expect(migration).toContain("match_status text NOT NULL CHECK (match_status IN ('matched', 'unmatched', 'ambiguous'))")
        expect(migration).toContain('UNIQUE (run_id, source_row_number)')
        expect(migration).toContain("source_url !~ '/(api|json|xml|ajax)/'")
        expect(migration).toContain('idx_fantasypros_projection_rows_daily_read')
        expect(migration).toContain('idx_fantasypros_projection_rows_weekly_read')
        expect(migration).toContain('idx_fantasypros_projection_rows_unmatched')

        expect(matchSource).toContain("match_status: 'matched' | 'unmatched' | 'ambiguous'")
        expect(matchSource).toContain("reason: 'no normalized-name match'")
    })

    it('locks projection write tables behind RLS and service-role mutation grants', () => {
        const runPolicy = latestPolicyDefinition('projection_sync_runs_select_authenticated', 'projection_sync_runs')
        const rowPolicy = latestPolicyDefinition('fantasypros_projection_rows_select_authenticated', 'fantasypros_projection_rows')
        const runPrivileges = tablePrivilegeStatements('projection_sync_runs').join('\n')
        const rowPrivileges = tablePrivilegeStatements('fantasypros_projection_rows').join('\n')

        expect(runPolicy).toContain('FOR SELECT TO authenticated USING (true)')
        expect(rowPolicy).toContain('FOR SELECT TO authenticated USING (true)')
        expect(runPrivileges).toContain('REVOKE ALL ON public.projection_sync_runs FROM anon, authenticated')
        expect(rowPrivileges).toContain('REVOKE ALL ON public.fantasypros_projection_rows FROM anon, authenticated')
        expect(runPrivileges).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.projection_sync_runs TO service_role')
        expect(rowPrivileges).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.fantasypros_projection_rows TO service_role')
    })

    it('uses public FantasyPros HTML only and enforces the crawl delay between source pages', () => {
        expect(syncProjectionSource).toContain('https://www.fantasypros.com/nba/projections/daily-overall.php')
        expect(syncProjectionSource).toContain('https://www.fantasypros.com/nba/projections/avg-weekly-overall.php')
        expect(syncProjectionSource).toContain('https://www.fantasypros.com/nba/projections/weekly-overall.php')
        expect(syncProjectionSource).not.toMatch(/fantasypros\.com\/(?:api|json|xml|ajax)\//)
        expect(syncProjectionSource).toContain('const FANTASYPROS_DELAY_MS = 5000')
        expect(syncProjectionSource).toContain('if (i > 0) await sleep(FANTASYPROS_DELAY_MS)')
        expect(syncProjectionSource).toContain("'Accept': 'text/html,application/xhtml+xml'")
        expect(parserSource).toContain('findProjectionTable')
    })

    it('schedules backend cron refreshes and keeps the wrapper service-role only', () => {
        const cron = latestCronScheduleStatement('nba-sync-projections')
        const wrapper = latestFunctionDefinition('invoke_projection_sync_if_due')
        const privileges = functionPrivilegeStatements('invoke_projection_sync_if_due').join('\n')

        expect(cron).toContain("'0 12-23 * * *'")
        expect(cron).toContain('public.invoke_projection_sync_if_due()')
        expect(wrapper).toContain('EXTRACT(HOUR FROM v_now_et)::int = 8')
        expect(wrapper).toContain('now() < v_first_lock')
        expect(wrapper).toContain("public.invoke_edge_function('sync-projections')")
        expect(privileges).toContain('REVOKE ALL ON FUNCTION public.invoke_projection_sync_if_due() FROM PUBLIC')
        expect(privileges).toContain('REVOKE ALL ON FUNCTION public.invoke_projection_sync_if_due() FROM authenticated')
        expect(privileges).toContain('GRANT EXECUTE ON FUNCTION public.invoke_projection_sync_if_due() TO service_role')
    })

    it('exposes league-scored projection priority and fallback behavior through one RPC', () => {
        const projectionRpc = latestFunctionDefinition('get_league_projection_rows')
        const scoringRpc = latestFunctionDefinition('projection_stat_fantasy_points')

        expect(scoringRpc).toContain("p_scoring_settings->>'points'")
        expect(scoringRpc).toContain("p_scoring_settings->>'three_pointers_made'")
        expect(projectionRpc).toContain("r.projection_type = 'daily'")
        expect(projectionRpc).toContain("r.fetched_at >= now() - interval '36 hours'")
        expect(projectionRpc).toContain("r.projection_type = 'weekly_avg'")
        expect(projectionRpc).toContain("r.projection_type = 'weekly_total'")
        expect(projectionRpc).toContain('public.player_projections pp')
        expect(projectionRpc).toContain('public.mv_player_season_averages avg')
        expect(projectionRpc).toContain("CASE WHEN args.view_name = 'week_avg' THEN 1 ELSE 2 END AS priority")
        expect(projectionRpc).toContain('ORDER BY cu.player_id, cu.priority ASC')
    })

    it('wires player, projections, manual Auto-Set, and season optimizer surfaces to the shared projection source', () => {
        expect(projectionsScreen).toContain('VIEW_OPTIONS')
        expect(projectionsScreen).toContain("'today'")
        expect(projectionsScreen).toContain("'week_avg'")
        expect(projectionsScreen).toContain("'week_total'")
        expect(projectionsScreen).toContain("'mine'")
        expect(projectionsScreen).toContain("'available'")
        expect(projectionsScreen).toContain('getLeagueProjections')
        expect(playerItem).toContain('projection_fantasy_points')
        expect(playerItem).toContain('projection_source_label')
        expect(playerDetail).toContain('NextProjectionCard')

        expect(autoSetSource).toContain('getProjectionMap')
        expect(autoSetSource).toContain('projection_fantasy_points')
        expect(lineupOptimizerSource).toContain("db.rpc('get_league_projection_rows'")
        expect(lineupOptimizerSource).toContain('projection_fantasy_points')
    })
})
