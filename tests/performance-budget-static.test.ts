import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { read, readFunctionSource } from './source-guard'

const manifest = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/e2e/performance-budgets.json'), 'utf8'))

describe('instant-loading performance budget contract', () => {
    it('ranks exactly 10 workflows with budgets matching the instant-loading goal', () => {
        expect(manifest.version).toBe(1)
        expect(manifest.workflows).toHaveLength(10)
        expect(manifest.globalBudgets.minHeartbeatSamples).toBe(10)

        const ranks = manifest.workflows.map((workflow: any) => workflow.rank).sort((a: number, b: number) => a - b)
        expect(ranks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

        const ids = new Set<string>()
        for (const workflow of manifest.workflows) {
            expect(workflow.id).toMatch(/^[a-z0-9-]+$/)
            expect(ids.has(workflow.id)).toBe(false)
            ids.add(workflow.id)

            expect(workflow.name).toEqual(expect.any(String))
            expect(workflow.name.trim()).not.toHaveLength(0)
            expect(workflow.frequency).toEqual(expect.any(String))
            expect(workflow.frequency.trim()).not.toHaveLength(0)
            expect(workflow.pain).toEqual(expect.any(String))
            expect(workflow.pain.trim()).not.toHaveLength(0)
            expect(workflow.criticalPath.length).toBeGreaterThanOrEqual(3)
            expect(workflow.measurement.primary).toMatch(/^npm run |^E2E_/)
            expect(workflow.measurement.report).toMatch(/^tests\//)

            expect(workflow.budgets.feedbackMs).toBeLessThanOrEqual(manifest.globalBudgets.instantFeedbackMs)
            expect(workflow.budgets.cachedRequestMs).toBeLessThanOrEqual(manifest.globalBudgets.cachedRequestMs)
            expect(workflow.budgets.fullLoadMs).toBeLessThanOrEqual(manifest.globalBudgets.fullWorkflowMs)
        }
    })

    it('keeps the highest-load reads backed by instant-loading database work', () => {
        const playerSearchMigration = read('supabase/migrations/20260702000001_player_search_performance_cache.sql')
        const playerSearchDefaultMigration = read('supabase/migrations/20260702000004_search_players_default_page_size.sql')
        const readIndexMigration = read('supabase/migrations/20260702000002_instant_app_read_indexes.sql')
        const secondaryIndexMigration = read('supabase/migrations/20260702000003_instant_app_secondary_read_indexes.sql')
        const playerSearchState = read('lib/player-search-state.ts')
        const playersLib = read('lib/players.ts')
        const dataLatencyBench = read('tests/e2e/data-latency-bench.mjs')

        expect(playerSearchMigration).toContain('analytics.mv_player_avg_fantasy_points')
        expect(playerSearchMigration).toContain('paged_base AS')
        expect(playerSearchMigration).toContain('p_limit int DEFAULT 20')
        expect(playerSearchDefaultMigration).toContain('p_limit int DEFAULT 20')
        expect(playerSearchDefaultMigration).toContain('LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100) AS page_limit')
        expect(playerSearchState).toContain('PLAYER_SEARCH_PAGE_SIZE = 20')
        expect(playersLib).toContain('DEFAULT_PLAYER_SEARCH_PAGE_SIZE = 20')
        expect(dataLatencyBench).toContain('const PLAYER_SEARCH_PAGE_SIZE = 20')
        expect(dataLatencyBench).toContain('p_limit: PLAYER_SEARCH_PAGE_SIZE')
        expect(readIndexMigration).toContain('idx_weekly_lineups_member_date_read')
        expect(readIndexMigration).toContain('idx_roster_players_member_season_read')
        expect(readIndexMigration).toContain('idx_waiver_claims_member_season_active')
        expect(readIndexMigration).toContain('idx_trades_league_proposer_recent')
        expect(secondaryIndexMigration).toContain('idx_nominations_draft_order_instant')
        expect(secondaryIndexMigration).toContain('idx_players_rookie_board_instant')
    })

    it('serves fantasy averages to leagues created after the last cache refresh', () => {
        const freshTableMigration = read('supabase/migrations/20260703000003_fresh_league_fantasy_avg_table.sql')

        // New leagues get seeded rows at creation (trigger) and the view unions
        // the indexed side table for leagues the nightly MV has not covered —
        // no live aggregation in the hot path, no NULL FP for fresh leagues.
        expect(freshTableMigration).toContain('analytics.player_avg_fantasy_points_fresh')
        expect(freshTableMigration).toContain('CREATE TRIGGER leagues_seed_fantasy_avgs')
        expect(freshTableMigration).toContain('AFTER INSERT ON public.leagues')
        expect(freshTableMigration).toContain('CREATE OR REPLACE VIEW public.v_player_avg_fantasy_points')
        expect(freshTableMigration).toContain('UNION ALL')
        expect(freshTableMigration).toContain('DELETE FROM analytics.player_avg_fantasy_points_fresh fresh')
    })

    it('never dresses plain points up as fantasy points', () => {
        const fpHonestyMigration = read('supabase/migrations/20260703000002_search_players_fp_no_pts_fallback.sql')
        const canonicalSearch = readFunctionSource('search_players')
        const searchItem = read('components/PlayerSearchItem.tsx')

        expect(fpHonestyMigration).not.toContain('COALESCE(fp.avg_fantasy_points, avg.avg_points)')
        expect(canonicalSearch).not.toContain('COALESCE(fp.avg_fantasy_points, avg.avg_points)')
        expect(searchItem).not.toContain('item.avg_fantasy_points ?? item.avg_points')
    })

    it('plans player search from the current league and filters', () => {
        const canonicalSearch = readFunctionSource('search_players')

        expect(canonicalSearch).toContain('LANGUAGE plpgsql')
        expect(canonicalSearch).toContain('SET plan_cache_mode = force_custom_plan')
        expect(canonicalSearch).toContain('RETURN QUERY')
    })

    it('wires performance budgets into the normal release surface', () => {
        const packageJson = JSON.parse(read('package.json'))
        const readme = read('README.md')
        const e2eReadme = read('tests/e2e/README.md')
        const productionReadiness = read('tests/e2e/production-readiness.mjs')
        const seedLeague = read('tests/e2e/seed-league.mjs')
        const releaseWorkflow = read('.github/workflows/release-soak.yml')
        const testWorkflow = read('.github/workflows/test.yml')

        expect(packageJson.scripts['perf:budget']).toBe('node tests/e2e/performance-budgets.mjs')
        expect(packageJson.scripts['e2e:data-latency']).toBe('node tests/e2e/data-latency-bench.mjs')
        expect(readme).toContain('npm run perf:budget')
        expect(e2eReadme).toContain('performance-budgets.json')
        expect(productionReadiness).not.toContain("run('npm', ['run', 'perf:budget']")
        expect(seedLeague).toContain('seedLatencyFixtures')
        expect(seedLeague).toContain("admin.from('matchups').insert")
        expect(seedLeague).toContain("admin.from('snake_draft_picks').insert")
        expect(releaseWorkflow).toContain('npm run e2e:data-latency')
        expect(releaseWorkflow).toContain('npm run perf:budget -- --require-report --require-data-report --require-workflow-reports')
        expect(releaseWorkflow).toContain('tests/snapshots/')
        expect(testWorkflow).toContain('npm run perf:budget -- --require-report')
    })

    it('keeps major app screens free of generic skeleton loading surfaces', () => {
        const leagueScreen = read('app/(tabs)/league.tsx')
        const tradesScreen = read('app/(tabs)/trades.tsx')
        const rosterScreen = read('app/(tabs)/roster.tsx')
        const playersScreen = read('app/(tabs)/players.tsx')
        const homeScreen = read('app/(tabs)/index.tsx')
        const draftRoomTab = read('app/(tabs)/draft-room.tsx')
        const dynastyScreen = read('app/(tabs)/dynasty.tsx')
        const draftActiveState = read('components/league/DraftActiveState.tsx')
        const playerSearchHook = read('hooks/use-player-search.ts')

        for (const [name, source] of Object.entries({
            leagueScreen,
            tradesScreen,
            rosterScreen,
            playersScreen,
            homeScreen,
            draftRoomTab,
            dynastyScreen,
            draftActiveState,
        })) {
            expect(source, name).not.toContain('LoadingShell')
            expect(source, name).not.toContain('Skeleton')
            expect(source, name).not.toContain('TradeListPlaceholder')
            expect(source, name).not.toContain('RosterLoadingShell')
            expect(source, name).not.toContain('LeagueTabPlaceholder')
            expect(source, name).not.toContain('PlayerListLoadingRows')
            expect(source, name).not.toContain('MatchupLineupPlaceholder')
            expect(source, name).not.toContain('ActivityIndicator')
        }

        // No active-draft loading placeholder: the card renders only once the
        // draft status is known, so nothing collapses or shifts on resolve.
        expect(draftActiveState).not.toContain('ActiveDraftLoadingNotice')
        expect(draftActiveState).not.toContain('Draft status updating')
        expect(draftActiveState).not.toContain('draftLoadingTitlePlaceholder')
        expect(homeScreen).not.toContain('matchupPlaceholderRow')
        // Dynasty rankings/news render nothing until hydrated — no skeleton
        // rows and no "Loading…" cards that swap for different content.
        expect(dynastyScreen).not.toContain('RankingsLoadingRows')
        expect(dynastyScreen).not.toContain('NewsLoadingRows')
        expect(dynastyScreen).not.toContain('rankLoadingRow')
        expect(dynastyScreen).not.toContain('newsLoadingRow')
        expect(dynastyScreen).not.toContain('Loading dynasty rankings')
        expect(dynastyScreen).not.toContain('Loading dynasty news')
        expect(playerSearchHook).toContain('lastLeagueIdRef')
        expect(playerSearchHook).not.toContain('isFirstLeagueRunRef')
    })
})
