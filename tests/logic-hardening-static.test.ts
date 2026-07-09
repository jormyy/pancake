import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import {
    latestCronScheduleStatement,
    latestFunctionDefinition,
    latestViewDefinition,
    ROOT,
    read,
    sources,
} from './source-guard'

const {
    etSeasonYearMigration,
    inviteCodeSecurityMigration,
    rpcArrayCapsMigration,
} = sources

describe('logic hardening source guards - scoring and security', () => {
    it('rounds SQL scoring at both compute_fantasy_points and v_fantasy_points sites', () => {
        const fnBody = latestFunctionDefinition('compute_fantasy_points')
        const viewBody = latestViewDefinition('v_fantasy_points')

        expect(fnBody).toMatch(/RETURN\s+ROUND\(v_total,\s*2\)/i)
        expect(viewBody).toMatch(/THEN\s+0::numeric\s+ELSE\s+ROUND\(/i)
    })

    it('keeps Edge weekly scoring behind the regular-season predicate', () => {
        const edgeScores = read('supabase/functions/_shared/syncScores.ts')

        expect(edgeScores).toContain('nba_games!inner(nba_game_id')
        expect(edgeScores).toContain('isRegularSeasonGameId')
    })

    it('keeps product game/stat read paths behind the regular-season predicate', () => {
        expect(read('lib/games.ts')).toContain('isRegularSeasonGameId')
        expect(read('lib/players.ts')).toContain(".like('nba_games.nba_game_id', '002%')")
    })

    it('uses an ET-aware cron wrapper for daily wall-clock jobs', () => {
        const wrapper = latestFunctionDefinition('invoke_edge_function_at_et_time')

        expect(wrapper).toContain('invoke_edge_function_at_et_time')
        expect(wrapper).toContain("timezone('America/New_York', now())")
        expect(latestCronScheduleStatement('nba-sync-players')).toContain("'sync-players', 6, 0")
        expect(latestCronScheduleStatement('nba-sync-schedule')).toContain("'sync-schedule', 6, 5")
        expect(latestCronScheduleStatement('nba-sync-projections')).toContain('public.invoke_projection_sync_if_due()')
        expect(latestFunctionDefinition('invoke_projection_sync_if_due')).toContain('now() < v_first_lock')
        expect(latestCronScheduleStatement('nba-sync-rankings')).toContain("'sync-rankings', 7, 0")
        expect(latestCronScheduleStatement('nba-process-waivers')).toContain("'process-waivers', 3, 0")
    })

    it('removes nondeterministic draft order from auction and rookie startup', () => {
        expect(read('supabase/functions/api/draft.ts')).not.toContain('Math.random')
        const auctionStartup = latestFunctionDefinition('start_auction_draft_atomic')
        const rookieStartup = latestFunctionDefinition('start_rookie_draft_atomic')

        expect(auctionStartup).not.toContain('random()')
        expect(rookieStartup).not.toContain('random()')
        expect(auctionStartup).toMatch(/row_number\(\) OVER \(ORDER BY lm\.joined_at ASC, lm\.id ASC\)/)
        expect(rookieStartup).toMatch(/points_for ASC,\s+member_id ASC/)
    })

    it('keeps cron Edge invocation on the linked pg_net signature', () => {
        const invokeBody = latestFunctionDefinition('invoke_edge_function')

        expect(invokeBody).toContain('PERFORM net.http_post(')
        expect(invokeBody).toContain("'/functions/v1/' || function_name")
        expect(invokeBody).toContain('body,')
        expect(invokeBody).toContain('30000')
        expect(invokeBody).toContain('app.supabase_url')
        expect(invokeBody).toContain('app.edge_internal_token')
        expect(invokeBody).toContain('x-internal-function-token')
        expect(invokeBody).not.toContain('https://ceeytbfmwsnzalxlkalc.supabase.co')
        expect(invokeBody).not.toMatch(/COALESCE[\s\S]*app\.supabase_url/i)
        expect(invokeBody).not.toContain('app.service_role_key')
        expect(invokeBody).not.toContain("'Authorization'")
        expect(invokeBody).not.toContain("'apikey'")
        expect(invokeBody).not.toMatch(/\burl\s*=>|\bheaders\s*=>|\bbody\s*=>/i)
    })

    it('requires internal authorization before privileged Edge handlers run', () => {
        const authHelper = read('supabase/functions/_shared/auth.ts')
        expect(authHelper).toContain('requireInternalFunctionAuth')
        expect(authHelper).toContain('PANCAKE_EDGE_INTERNAL_TOKEN')
        expect(authHelper).toContain('EDGE_FUNCTION_INTERNAL_TOKEN')
        expect(authHelper).toContain('x-internal-function-token')
        expect(authHelper).not.toContain('PANCAKE_SUPABASE_SECRET_KEY')
        expect(authHelper).not.toContain('SUPABASE_SECRET_KEY')
        expect(authHelper).not.toContain('SUPABASE_SECRET_KEYS')
        expect(authHelper).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
        expect(authHelper).not.toContain('SUPABASE_ANON_KEY')
        expect(authHelper).not.toContain("req.headers.get('authorization')")
        expect(authHelper).not.toContain('Bearer')

        const serveHelper = read('supabase/functions/_shared/serve.ts')
        expect(serveHelper).toContain("import { requireInternalFunctionAuth } from './auth.ts'")
        expect(serveHelper).toContain('const authError = requireInternalFunctionAuth(req)')
        expect(serveHelper).toContain('if (authError) return authError')

        const edgeFunctions = readdirSync(path.join(ROOT, 'supabase/functions'), { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && entry.name !== 'api')
            .map((entry) => entry.name)

        for (const functionName of edgeFunctions) {
            const src = read(`supabase/functions/${functionName}/index.ts`)
            const usesServeInternal =
                src.includes("import { serveInternal } from '../_shared/serve.ts'") &&
                src.includes('serveInternal(')
            const usesRawGuard =
                src.includes("import { requireInternalFunctionAuth } from '../_shared/auth.ts'") &&
                src.includes('const authError = requireInternalFunctionAuth(req)') &&
                src.includes('if (authError) return authError')
            expect(
                usesServeInternal || usesRawGuard,
                `${functionName}/index.ts must authenticate internal requests via serveInternal or requireInternalFunctionAuth`,
            ).toBe(true)
            if (!usesRawGuard) {
                expect(src, `${functionName}/index.ts must route Deno.serve through serveInternal`).not.toContain('Deno.serve(')
            }
        }
    })

    it('uses high-entropy invite codes for league joins', () => {
        expect(inviteCodeSecurityMigration).toContain('FUNCTION public.generate_invite_code')
        expect(inviteCodeSecurityMigration).toContain("upper(encode(extensions.gen_random_bytes(8), 'hex'))")
        expect(inviteCodeSecurityMigration).toContain("invite_code !~ '^[A-Z0-9]{16}$'")
        expect(inviteCodeSecurityMigration).toContain("CHECK (invite_code IS NULL OR invite_code ~ '^[A-Z0-9]{16}$')")

        const createBody = inviteCodeSecurityMigration.slice(
            inviteCodeSecurityMigration.indexOf('FUNCTION public.create_league'),
            inviteCodeSecurityMigration.indexOf('FUNCTION public.join_league_by_invite_code'),
        )
        const joinBody = inviteCodeSecurityMigration.slice(
            inviteCodeSecurityMigration.indexOf('FUNCTION public.join_league_by_invite_code'),
            inviteCodeSecurityMigration.indexOf('REVOKE ALL ON FUNCTION public.create_league'),
        )

        expect(createBody).toContain('v_invite_code := public.generate_invite_code();')
        expect(createBody).not.toContain("substring(replace(gen_random_uuid()::text, '-', ''), 1, 6)")
        expect(joinBody).toContain("v_invite_code !~ '^[A-Z0-9]{16}$'")
        expect(joinBody).toContain('WHERE  invite_code = v_invite_code')
    })

    it('bounds authenticated JSON-array RPC workloads before expansion', () => {
        expect(rpcArrayCapsMigration).toContain('update_lineup_slots_atomic_unchecked_legacy')
        expect(rpcArrayCapsMigration).toContain('jsonb_array_length(p_slots) > 16')
        expect(rpcArrayCapsMigration).toContain('jsonb_array_length(p_moves) > 64')
        expect(rpcArrayCapsMigration).toContain('jsonb_array_length(p_assignments) > 64')

        const slotBody = latestFunctionDefinition('update_lineup_slots_atomic')
        const movesBody = latestFunctionDefinition('set_player_slot_moves_atomic')
        const autoSetBody = latestFunctionDefinition('auto_set_lineup_atomic')

        expect(slotBody.indexOf('jsonb_array_length(p_slots) > 16')).toBeGreaterThan(-1)
        expect(slotBody.lastIndexOf('update_lineup_slots_atomic_unchecked')).toBeGreaterThan(slotBody.indexOf('jsonb_array_length(p_slots) > 16'))
        expect(movesBody.indexOf('jsonb_array_length(p_moves) > 64')).toBeGreaterThan(-1)
        expect(movesBody.indexOf('set_player_slot_moves_atomic_unchecked')).toBeGreaterThan(movesBody.indexOf('jsonb_array_length(p_moves) > 64'))
        expect(autoSetBody.indexOf('jsonb_array_length(p_assignments) > 64')).toBeGreaterThan(-1)
        expect(autoSetBody.indexOf('auto_set_lineup_atomic_unchecked')).toBeGreaterThan(autoSetBody.indexOf('jsonb_array_length(p_assignments) > 64'))
    })

    it('neutralizes legacy RPC helper names in a forward migration', () => {
        const cleanup = read('supabase/migrations/20260627000025_neutral_rpc_helpers.sql')
        expect(cleanup).toContain('RENAME TO update_lineup_slots_atomic_unchecked')
        expect(cleanup).toContain('RENAME TO set_player_slot_moves_atomic_unchecked')
        expect(cleanup).toContain('RENAME TO auto_set_lineup_atomic_unchecked')
        expect(cleanup).toContain('PERFORM public.update_lineup_slots_atomic_unchecked(p_league_id, p_slots)')
        expect(cleanup).toContain('PERFORM public.set_player_slot_moves_atomic_unchecked(')
        expect(cleanup).toContain('PERFORM public.auto_set_lineup_atomic_unchecked(')
        expect(cleanup).toContain('REVOKE ALL ON FUNCTION public.update_lineup_slots_atomic_unchecked')
        expect(cleanup).not.toContain('PERFORM public.update_lineup_slots_atomic_unchecked_legacy')
        expect(cleanup).not.toContain('PERFORM public.set_player_slot_moves_atomic_unchecked_legacy')
        expect(cleanup).not.toContain('PERFORM public.auto_set_lineup_atomic_unchecked_legacy')
    })

    it('keeps rookie draft startup lintable without pg_temp tables', () => {
        const rookieBody = latestFunctionDefinition('start_rookie_draft_atomic')

        expect(rookieBody).toContain('WITH ordered_members AS')
        expect(rookieBody).toContain('rookie_draft_order AS')
        expect(rookieBody).toContain('INSERT INTO draft_orders')
        expect(rookieBody).toContain('CROSS JOIN draft_orders AS ordered')
        expect(rookieBody).not.toContain('CREATE TEMP TABLE')
        expect(rookieBody).not.toContain('pg_temp.rookie_draft_order')
    })

    it('guards auction close against active roster over-cap commits', () => {
        const closeBody = latestFunctionDefinition('close_auction_nomination_atomic')

        expect(closeBody).toContain('v_active_roster_count')
        expect(closeBody).toMatch(/v_active_roster_count\s+>=\s+v_roster_size/)
        expect(closeBody).toMatch(/SET status = 'no_bid'/)
    })

    it('completes auction drafts when no single manager has both budget and roster space', () => {
        const closeBody = latestFunctionDefinition('close_auction_nomination_atomic')
        const completionBody = closeBody.slice(closeBody.indexOf('IF NOT EXISTS ('))

        expect(completionBody).toContain('JOIN draft_budgets db')
        expect(completionBody).toContain('db.member_id = lm.id')
        expect(completionBody).toContain('db.remaining >= 1')
        expect(completionBody).toContain('< v_roster_size')
        expect(completionBody).not.toMatch(/remaining\s+>=\s+1[\s\S]*\)\s+OR\s+NOT\s+EXISTS/i)
    })

    it('keeps TS scoring copies on the shared SQL-compatible rounding helper', () => {
        for (const rel of [
            'core/src/scoring/formula.ts',
            'supabase/functions/_shared/scoringCore.ts',
        ]) {
            const src = read(rel)
            expect(src).toContain('roundFantasyPoints')
            expect(src).toContain("split('e')")
            expect(src).toContain('Math.round(shifted)')
            expect(src).not.toContain('.toFixed(2)')
        }
        expect(read('supabase/functions/_shared/scoring.ts')).toContain('./scoringCore.ts')
    })

    it('only treats missing minutes as DNP in Edge stat sync', () => {
        for (const rel of [
            'supabase/functions/_shared/syncStats.ts',
            'supabase/functions/_shared/bbrefBackfill.ts',
        ]) {
            const src = read(rel)
            expect(src).toMatch(/const (?:dnp|didNotPlay) = (?:stat\.dnp \|\| )?minutesPlayed == null/)
            expect(src).not.toContain('minutesPlayed < 0.5')
        }
    })

    it('does not let non-regular pending games block week finalization', () => {
        const src = read('supabase/functions/_shared/syncScores.ts')
        expect(src).toContain(".select('id, nba_game_id')")
        expect(src).toContain('isRegularSeasonGameId(game.nba_game_id)')
    })

    it('paginates player game logs after query-level regular-season filtering', () => {
        const players = read('lib/players.ts')
        expect(players).toContain("nba_games!inner ( id, nba_game_id, game_date, home_team, away_team )")
        expect(players).toContain(".like('nba_games.nba_game_id', '002%')")
        expect(players).toContain('.range(offset, offset + fetchLimit - 1)')
        expect(players).not.toContain('regularRows.push(...page.filter')
    })

    it('uses ET season year and setup status for league creation', () => {
        const createLeagueBody = latestFunctionDefinition('create_league')

        expect(etSeasonYearMigration).toContain('FUNCTION public.current_season_year_et')
        expect(etSeasonYearMigration).toContain("timezone('America/New_York', p_now)")
        expect(createLeagueBody).toContain('v_season_year := public.current_season_year_et();')
        expect(createLeagueBody).toContain('generate_series(v_season_year + 1, v_season_year + 5)')
        expect(createLeagueBody).toContain('CROSS JOIN generate_series(1, 3)')
        expect(createLeagueBody).not.toMatch(/\(20\d{2},\s*[123]\)/)
        expect(createLeagueBody).toContain("'status',          'setup'")
        expect(createLeagueBody).not.toMatch(/extract\(month\s+FROM\s+now\(\)\)/i)
    })
})
