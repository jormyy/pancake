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
        expect(read('supabase/functions/process-trades/index.ts')).toContain('complete_accepted_trade_atomic')
        expect(read('supabase/functions/close-expired-nominations/index.ts')).toContain('close_auction_nomination_atomic')

        const migration = read('supabase/migrations/20260628000003_supabase_api_cron_cutover.sql')
        expect(migration).toContain('x-internal-function-token')
        expect(migration).toContain("'nba-process-trades'")
        expect(migration).toContain("'nba-close-expired-nominations'")
    })

    it('isolates the former Railway backend outside active runtime paths', () => {
        const rootPackage = JSON.parse(read('package.json')) as { workspaces?: string[]; scripts?: Record<string, string> }

        expect(existsSync('backend')).toBe(false)
        expect(rootPackage.workspaces ?? []).not.toContain('backend')
        expect(Object.values(rootPackage.scripts ?? {}).join('\n')).not.toContain('--workspace backend')
        expect(read('backend-legacy-railway/README.md')).toContain('non-runtime rollback reference')
    })
})
