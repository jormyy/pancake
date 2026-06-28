import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('Supabase Edge API cutover', () => {
    it('type-checks the routed API and background functions', () => {
        const result = spawnSync('npm', ['run', 'check:edge-functions'], {
            cwd: process.cwd(),
            encoding: 'utf8',
        })

        expect(result.status, result.stderr || result.stdout).toBe(0)
    })

    it('covers the migrated user-facing Fastify route surface', () => {
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

    it('moves Railway interval work to Supabase Edge cron targets', () => {
        const processTrades = read('supabase/functions/process-trades/index.ts')
        const closeNominations = read('supabase/functions/close-expired-nominations/index.ts')

        expect(processTrades).toContain('process_due_accepted_trades_atomic')
        expect(processTrades).not.toContain('complete_accepted_trade_atomic')
        expect(processTrades).not.toContain('TERMINAL_COMPLETION_ERROR_FRAGMENTS')
        expect(closeNominations).toContain('close_expired_auction_nominations_atomic')
        expect(closeNominations).not.toContain('close_auction_nomination_atomic')
        expect(`${processTrades}\n${closeNominations}`).not.toContain('Promise.allSettled')

        const migration = read('supabase/migrations/20260628000003_supabase_api_cron_cutover.sql')
        expect(migration).toContain('x-internal-function-token')
        expect(migration).toContain("'nba-process-trades'")
        expect(migration).toContain("'nba-close-expired-nominations'")
    })

    it('keeps schedule and playoff bracket writes inside atomic SQL RPCs', () => {
        const matchups = read('supabase/functions/api/matchups.ts')
        const playoffs = read('supabase/functions/api/playoffs.ts')
        const migration = read('supabase/migrations/20260628000005_edge_atomic_playoffs_and_trade_terminal.sql')

        expect(matchups).toContain('replace_regular_season_matchups_atomic')
        expect(playoffs).toContain('generate_playoff_bracket_atomic')
        expect(playoffs).toContain('advance_playoff_bracket_atomic')
        expect(`${matchups}\n${playoffs}`).not.toMatch(/from\('matchups'\)\.(?:insert|delete|upsert|update)/)
        expect(`${matchups}\n${playoffs}`).not.toMatch(/from\('rps_challenges'\)\.(?:insert|delete|upsert|update)/)
        expect(migration).toContain('pg_advisory_xact_lock')
        expect(migration).toContain('generate_playoff_bracket_atomic')
        expect(migration).toContain('advance_playoff_bracket_atomic')
        expect(migration).toContain('FOR UPDATE OF trade SKIP LOCKED')
        expect(read('types/database.ts')).toContain('replace_regular_season_matchups_atomic')
        expect(read('types/database.ts')).toContain('generate_playoff_bracket_atomic')
        expect(read('types/database.ts')).toContain('advance_playoff_bracket_atomic')
        expect(read('types/database.ts')).toContain('process_due_accepted_trades_atomic')
        expect(read('types/database.ts')).toContain('close_expired_auction_nominations_atomic')
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

    it('isolates the former Railway backend outside active runtime paths', () => {
        const rootPackage = JSON.parse(read('package.json')) as { workspaces?: string[]; scripts?: Record<string, string> }

        expect(existsSync('backend')).toBe(false)
        expect(rootPackage.workspaces ?? []).not.toContain('backend')
        expect(Object.values(rootPackage.scripts ?? {}).join('\n')).not.toContain('--workspace backend')
        expect(read('scripts/generate-edge-shared.mjs')).not.toContain('backend-legacy-railway/src')
        expect(read('backend-legacy-railway/README.md')).toContain('non-runtime rollback reference')
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
