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
        const playerSearchState = read('lib/player-search-state.ts')
        const playersLib = read('lib/players.ts')
        const dataLatencyBench = read('tests/e2e/data-latency-bench.mjs')

        expect(playerSearchState).toContain('PLAYER_SEARCH_PAGE_SIZE = 20')
        expect(playersLib).toContain('DEFAULT_PLAYER_SEARCH_PAGE_SIZE = 20')
        expect(dataLatencyBench).toContain('const PLAYER_SEARCH_PAGE_SIZE = 20')
        expect(dataLatencyBench).toContain('p_limit: PLAYER_SEARCH_PAGE_SIZE')
    })

    it('never dresses plain points up as fantasy points', () => {
        const canonicalSearch = readFunctionSource('search_players')
        const searchItem = read('components/PlayerSearchItem.tsx')

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
        const seedLeague = read('tests/e2e/seed-league.mjs')
        const releaseWorkflow = read('.github/workflows/release-soak-shard.yml')
        const testWorkflow = read('.github/workflows/test.yml')

        expect(packageJson.scripts['perf:budget']).toBe('node tests/e2e/performance-budgets.mjs')
        expect(packageJson.scripts['e2e:data-latency']).toBe('node tests/e2e/data-latency-bench.mjs')
        expect(readme).toContain('npm run perf:budget')
        expect(e2eReadme).toContain('performance-budgets.json')
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
        const draftRoomTab = read('app/(tabs)/draft.tsx')
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
        // The result guard now owns the entire identity/query, including league.
        expect(playerSearchHook).toContain('dataKey === searchParamsKey')
        expect(playerSearchHook).not.toContain('isFirstLeagueRunRef')
    })
})
