import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('Supabase Edge API cutover', () => {
    it('covers the migrated user-facing route surface', () => {
        const apiSources = [
            'supabase/functions/api/games.ts',
            'supabase/functions/api/league.ts',
            'supabase/functions/api/waivers.ts',
            'supabase/functions/api/trades.ts',
            'supabase/functions/api/draft.ts',
            'supabase/functions/api/playoffs.ts',
            'supabase/functions/api/sync.ts',
            'supabase/functions/api/e2e.ts',
            'supabase/functions/api/index.ts',
        ].map(read).join('\n')

        const requiredRouteFragments = [
            '/games/today',
            '/league/roster/ir',
            '/league/roster/taxi',
            '/waivers/claims',
            '/waivers/process',
            '/trades/propose',
            "action.action === 'accept'",
            "action.action === 'reject'",
            "action.action === 'withdraw'",
            "action.action === 'veto'",
            '/draft/start',
            '/draft/start-rookie',
            "action.action === 'stop'",
            "action.action === 'reset'",
            "action.action === 'nominate'",
            "action.action === 'bid'",
            "action.action === 'withdraw-nomination'",
            "action.action === 'snake-pick'",
            "action.action === 'auto-pick'",
            "action.action === 'process-expired-pick'",
            "action.action === 'activate-rookie-league'",
            "action.action === 'reseed-picks'",
            '/playoffs/generate',
            '/playoffs/advance',
            '/league/advance-season',
            '/sync/stats',
            '/sync/scores',
            '/sync/schedule',
            '/sync/matchups',
            '/sync/players',
            '/sync/rankings',
            '/sync/projections',
            '/sync/draft-order',
            '/sync/backfill',
            '/sync/test-endpoints',
            '/sync/verify-stats',
            '/sync/season-totals',
            '/sync/validate-db',
            '/e2e/status',
            '/e2e/process-waivers',
            '/e2e/process-trades',
            '/e2e/close-expired-nominations',
        ]

        for (const fragment of requiredRouteFragments) {
            expect(apiSources, fragment).toContain(fragment)
        }
    })

    it('moves interval work to Supabase Edge cron targets', () => {
        const processTrades = read('supabase/functions/process-trades/index.ts')
        const closeNominations = read('supabase/functions/close-expired-nominations/index.ts')
        const processWaivers = read('supabase/functions/process-waivers/index.ts')

        expect(processTrades).toContain('process_due_accepted_trades_atomic')
        expect(processTrades).not.toContain('complete_accepted_trade_atomic')
        expect(processTrades).not.toContain('TERMINAL_COMPLETION_ERROR_FRAGMENTS')
        expect(closeNominations).toContain('close_expired_auction_nominations_atomic')
        expect(closeNominations).toContain('process_expired_snake_picks_atomic')
        expect(closeNominations).not.toContain('close_auction_nomination_atomic')
        expect(processWaivers).toContain('process_due_waiver_claims_atomic')
        expect(processWaivers).toContain('await Promise.all')
        expect(processWaivers).toContain('expire_waiver_wire_logs')
        expect(processWaivers).not.toContain('process_next_waiver_claim_atomic')
        expect(processWaivers).not.toContain('while (true)')
        expect(`${processTrades}\n${closeNominations}\n${processWaivers}`).not.toContain('Promise.allSettled')

        const cronInvoker = read('supabase/migrations/20260628000007_edge_cron_invoker_no_fallback.sql')
        expect(cronInvoker).toContain('x-internal-function-token')
        expect(cronInvoker).not.toContain('ceeytbfmwsnzalxlkalc')
        const migration = read('supabase/migrations/20260628000003_supabase_api_cron_cutover.sql')
        expect(migration).toContain("'nba-process-trades'")
        expect(migration).toContain("'nba-close-expired-nominations'")
        expect(read('types/database.ts')).toContain('process_due_waiver_claims_atomic')
    })

    it('keeps runtime API defaults environment-bound', () => {
        const api = read('lib/shared/api.ts')

        expect(api).toContain('EXPO_PUBLIC_API_URL')
        expect(api).toContain('EXPO_PUBLIC_SUPABASE_URL')
        expect(api).toContain('EXPO_PUBLIC_API_URL or EXPO_PUBLIC_SUPABASE_URL is required.')
        expect(api).not.toContain('DEFAULT_SUPABASE_URL')
        expect(api).not.toContain('ceeytbfmwsnzalxlkalc')
    })

    it('keeps DB behavior checks explicit about their target database', () => {
        const workflow = read('.github/workflows/test.yml')
        const rootPackage = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
        const dbScripts = [
            rootPackage.scripts?.['test:db:draft-goal'] ?? '',
            rootPackage.scripts?.['test:db:dynasty-ranking'] ?? '',
        ].join('\n')

        expect(workflow).not.toContain('supabase start')
        expect(workflow).not.toContain('supabase db reset')
        expect(workflow).not.toContain('supabase stop')
        expect(dbScripts).toContain('SUPABASE_DB_URL:?SUPABASE_DB_URL is required')
        expect(dbScripts).not.toContain('127.0.0.1:54322')
    })

    it('keeps schedule and playoff bracket writes inside atomic SQL RPCs', () => {
        const matchups = read('supabase/functions/api/matchups.ts')
        const playoffs = read('supabase/functions/api/playoffs.ts')
        const migration = read('supabase/migrations/20260628000008_edge_atomic_playoffs.sql')

        expect(matchups).toContain('replace_regular_season_matchups_atomic')
        expect(playoffs).toContain('generate_playoff_bracket_atomic')
        expect(playoffs).toContain('advance_playoff_bracket_atomic')
        expect(`${matchups}\n${playoffs}`).not.toMatch(/from\('matchups'\)\.(?:insert|delete|upsert|update)/)
        expect(`${matchups}\n${playoffs}`).not.toMatch(/from\('rps_challenges'\)\.(?:insert|delete|upsert|update)/)
        expect(migration).toContain('pg_advisory_xact_lock')
        expect(migration).toContain('playoff_seed_rankings')
        expect(migration).toContain('generate_playoff_bracket_atomic')
        expect(migration).toContain('advance_playoff_bracket_atomic')
        expect(read('supabase/migrations/20260628000005_edge_atomic_playoffs_and_trade_terminal.sql')).toContain('FOR UPDATE OF trade SKIP LOCKED')
        expect(read('types/database.ts')).toContain('replace_regular_season_matchups_atomic')
        expect(read('types/database.ts')).toContain('generate_playoff_bracket_atomic')
        expect(read('types/database.ts')).toContain('advance_playoff_bracket_atomic')
        expect(read('types/database.ts')).toContain('process_due_accepted_trades_atomic')
        expect(read('types/database.ts')).toContain('close_expired_auction_nominations_atomic')
        expect(read('types/database.ts')).toContain('process_expired_snake_picks_atomic')
    })

    it('keeps trade terminal states behind explicit SQL contracts', () => {
        const trades = read('supabase/functions/api/trades.ts')
        const migration = read('supabase/migrations/20260628000005_edge_atomic_playoffs_and_trade_terminal.sql')

        expect(trades).toContain('reject_trade_atomic')
        expect(trades).toContain('withdraw_trade_atomic')
        expect(trades).not.toMatch(/from\('trades'\)\.update/)
        expect(migration).toContain("USING ERRCODE = 'PT001'")
        expect(migration).toContain("IF v_error_code = 'PT001' THEN")
        expect(migration).not.toContain("v_error_code NOT IN")
        expect(migration).toContain('completion_failure_reason = p_reason')
        expect(read('types/database.ts')).toContain('reject_trade_atomic')
        expect(read('types/database.ts')).toContain('withdraw_trade_atomic')
    })

    it('removes the former backend from active runtime paths', () => {
        const rootPackage = JSON.parse(read('package.json')) as { workspaces?: string[]; scripts?: Record<string, string> }
        const workflow = read('.github/workflows/test.yml')
        const retiredBackendDir = ['backend', 'legacy', 'rail' + 'way'].join('-')

        expect(existsSync('backend')).toBe(false)
        expect(existsSync(retiredBackendDir)).toBe(false)
        expect(rootPackage.workspaces ?? []).not.toContain('backend')
        expect(Object.values(rootPackage.scripts ?? {}).join('\n')).not.toContain('--workspace backend')
        expect(workflow).not.toContain('--workspace backend')
        expect(workflow).toContain('npm run check:edge-functions')
        expect(read('scripts/generate-edge-shared.mjs')).not.toContain(retiredBackendDir)
        expect(read('README.md')).not.toContain(retiredBackendDir)
        expect(read('docs/supabase-backend-route-inventory.md')).not.toContain(retiredBackendDir)
    })

    it('keeps no-Authorization Edge entrypoints explicit in Supabase config', () => {
        const config = read('supabase/config.toml')
        const functionNames = readdirSync('supabase/functions', { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
            .map((entry) => entry.name)
            .sort()

        for (const functionName of functionNames) {
            const pattern = new RegExp(`\\[functions\\.${functionName}\\]\\s+verify_jwt\\s*=\\s*false`, 'm')
            expect(config, `${functionName} must be deployable without platform JWT verification`).toMatch(pattern)
        }
    })

    it('does not bypass generated RPC typing in the Edge API', () => {
        const apiSources = [
            'supabase/functions/api/draft.ts',
            'supabase/functions/api/league.ts',
            'supabase/functions/api/playoffs.ts',
            'supabase/functions/api/trades.ts',
            'supabase/functions/api/waivers.ts',
        ].map(read).join('\n')

        expect(apiSources).not.toContain('as unknown as')
        expect(apiSources).not.toContain('as any')
        expect(read('types/database.ts')).toContain('stop_draft_atomic')
        expect(read('types/database.ts')).toContain('reset_draft_atomic')
    })
})
