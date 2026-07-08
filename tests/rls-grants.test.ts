import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import {
    functionPrivilegeStatements,
    latestFunctionDefinition,
    latestPolicyDefinition,
    tablePrivilegeStatements,
} from './source-guard'

// Persistence-layer IDOR guard.
//
// These SECURITY DEFINER RPCs mutate gameplay state and DO NOT verify auth.uid()
// — they trust a caller-supplied member_id/league_id. That is safe ONLY because
// they are granted to `service_role` alone and reached exclusively through the
// backend, which re-derives the member from the authenticated JWT. If any were
// ever GRANTed EXECUTE to `authenticated`/`anon`, they become instant
// cross-team takeover primitives (steal players, forge bids/waivers/vetoes,
// toggle another team's IR, advance seasons).
//
// This test fails the build if any migration grants one of them to a client
// role — the exact mistake a future "make this feature work from the client"
// change would introduce.

const MIGRATIONS = path.resolve(__dirname, '../supabase/migrations')

const SERVICE_ROLE_ONLY_RPCS = [
    'propose_trade_atomic',
    'accept_trade_atomic',
    'reject_trade_atomic',
    'withdraw_trade_atomic',
    'complete_accepted_trade_atomic',
    'veto_trade_atomic',
    'expire_trade_completion_failure_atomic',
    'process_due_accepted_trades_atomic',
    'create_waiver_claim_atomic',
    'cancel_waiver_claim_atomic',
    'process_next_waiver_claim_atomic',
    'process_due_waiver_claims_atomic',
    'create_auction_nomination_atomic',
    'start_auction_draft_atomic',
    'place_auction_bid_atomic',
    'close_auction_nomination_atomic',
    'close_expired_auction_nominations_atomic',
    'process_expired_snake_picks_atomic',
    'process_expired_snake_pick_atomic',
    'withdraw_auction_nomination_atomic',
    'make_snake_pick_atomic',
    'auto_pick_snake_pick_atomic',
    'commissioner_snake_pick_atomic',
    'start_rookie_draft_atomic',
    'reseed_rookie_draft_picks_atomic',
    'advance_season_atomic',
    'toggle_ir_atomic',
    'toggle_taxi_atomic',
    'expire_waiver_wire_logs',
    'clear_ineligible_taxi_players',
    'replace_regular_season_matchups_atomic',
    'generate_playoff_bracket_atomic',
    'advance_playoff_bracket_atomic',
    'try_live_poll_lease',
    'release_live_poll_lease',
    'invoke_edge_function',
    'invoke_edge_function_at_et_time',
    'invoke_projection_sync_if_due',
    'merge_players',
    'merge_duplicate_players',
    'count_final_games_missing_stats',
]

const allMigrationSql = (): string =>
    readdirSync(MIGRATIONS)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => readFileSync(path.join(MIGRATIONS, f), 'utf8'))
        .join('\n')

describe('service-role-only RPCs are never granted to client roles', () => {
    const sql = allMigrationSql()

    it.each(SERVICE_ROLE_ONLY_RPCS)('%s is not GRANTed EXECUTE to authenticated/anon', (fn) => {
        const grants = [
            ...sql.matchAll(
                new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${fn}\\s*\\([^)]*\\)\\s+TO\\s+([^;]+);`, 'gi'),
            ),
        ]
        for (const match of grants) {
            const grantees = match[1].toLowerCase()
            expect(grantees, `${fn} granted to a client role: "${match[1].trim()}"`).not.toMatch(
                /\b(authenticated|anon|public)\b/,
            )
        }
    })

    it('every service-role-only RPC is explicitly granted to service_role somewhere', () => {
        for (const fn of SERVICE_ROLE_ONLY_RPCS) {
            const granted = new RegExp(
                `GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${fn}\\s*\\([^)]*\\)\\s+TO\\s+[^;]*\\bservice_role\\b`,
                'i',
            ).test(sql)
            expect(granted, `${fn} is never granted to service_role`).toBe(true)
        }
    })

    // CREATE FUNCTION grants EXECUTE to PUBLIC by default, and PostgREST exposes
    // any public function with EXECUTE as an RPC to anon/authenticated. A
    // service_role grant does NOT remove PUBLIC — only an explicit REVOKE does.
    it.each(SERVICE_ROLE_ONLY_RPCS)('%s has its default PUBLIC EXECUTE revoked', (fn) => {
        const revokedFromPublic = new RegExp(
            `REVOKE\\s+[^;]*\\bON\\s+FUNCTION\\s+(?:public\\.)?${fn}\\s*\\([^)]*\\)\\s+FROM\\s+[^;]*\\bPUBLIC\\b`,
            'i',
        ).test(sql)
        expect(revokedFromPublic, `${fn} never REVOKEs default EXECUTE FROM PUBLIC — still client-callable`).toBe(true)
    })

    it('no migration grants EXECUTE to client roles via a blanket / default-privilege statement', () => {
        // e.g. GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
        const blanketAll = sql.match(
            /GRANT\s+EXECUTE\s+ON\s+ALL\s+(?:FUNCTIONS|ROUTINES)\s+IN\s+SCHEMA\s+public\s+TO\s+[^;]+;/gi,
        ) ?? []
        for (const stmt of blanketAll) {
            expect(stmt.toLowerCase(), `blanket function grant to a client role: ${stmt}`).not.toMatch(
                /\b(authenticated|anon|public)\b/,
            )
        }
        // e.g. ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO authenticated;
        const defaultPriv = sql.match(
            /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*GRANT\s+EXECUTE\s+ON\s+(?:FUNCTIONS|ROUTINES)\s+TO\s+[^;]+;/gi,
        ) ?? []
        for (const stmt of defaultPriv) {
            expect(stmt.toLowerCase(), `default-privilege function grant to a client role: ${stmt}`).not.toMatch(
                /\b(authenticated|anon|public)\b/,
            )
        }
    })

    it('locks the ET cron Edge wrapper away from client roles', () => {
        const privileges = functionPrivilegeStatements('invoke_edge_function_at_et_time').join('\n')

        expect(privileges).toContain('REVOKE ALL ON FUNCTION public.invoke_edge_function_at_et_time(text, int, int) FROM PUBLIC')
        expect(privileges).toContain('REVOKE ALL ON FUNCTION public.invoke_edge_function_at_et_time(text, int, int) FROM anon')
        expect(privileges).toContain('REVOKE ALL ON FUNCTION public.invoke_edge_function_at_et_time(text, int, int) FROM authenticated')
        expect(privileges).toContain('GRANT EXECUTE ON FUNCTION public.invoke_edge_function_at_et_time(text, int, int) TO service_role')
    })
})

describe('trusted server table grants', () => {
    const sql = allMigrationSql()

    it('keeps service_role able to read through PostgREST after client grant lockdown', () => {
        expect(sql).toMatch(/GRANT\s+SELECT\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+public\s+TO\s+service_role;/i)
        expect(sql).toMatch(
            /ALTER\s+DEFAULT\s+PRIVILEGES\s+IN\s+SCHEMA\s+public\s+GRANT\s+SELECT\s+ON\s+TABLES\s+TO\s+service_role;/i,
        )
        expect(sql).not.toMatch(
            /GRANT\s+SELECT\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+public\s+TO\s+[^;]*\b(?:anon|authenticated|public)\b/i,
        )
    })
})

describe('waiver privacy policies', () => {
    it('does not allow league-wide reads of other managers pending waiver claims', () => {
        const claimPolicy = latestPolicyDefinition(
            'waiver_claims_select_own_pending_or_league_resolved',
            'waiver_claims',
        )

        expect(claimPolicy).toContain("status <> 'pending'::waiver_claim_status")
        expect(claimPolicy).toContain('OR member_id IN (SELECT private.my_member_ids())')
        expect(claimPolicy).not.toContain('USING (league_id IN (SELECT private.my_league_ids()))')
    })

    it('does not expose pending claim rows through the direct waiver table policy', () => {
        const claimPolicy = latestPolicyDefinition(
            'waiver_claims_select_own_pending_or_league_resolved',
            'waiver_claims',
        )

        expect(claimPolicy).toContain("status <> 'pending'::waiver_claim_status")
        expect(claimPolicy).toContain('OR member_id IN (SELECT private.my_member_ids())')
        expect(claimPolicy).not.toContain('priority_at_submission')
    })
})

describe('profile privacy and invite capacity policies', () => {
    it('blocks direct invite joins after the tenth league member', () => {
        const joinBody = latestFunctionDefinition('join_league_by_invite_code')

        expect(joinBody).toContain('v_member_count')
        expect(joinBody).toContain('SELECT count(*)')
        expect(joinBody).toContain('IF v_member_count >= 10 THEN')
        expect(joinBody).toContain('This league is full.')
    })

    it('does not allow global profile enumeration or client push-token reads', () => {
        const profilePolicy = latestPolicyDefinition('profiles_select_self_or_shared_league', 'profiles')
        const profilePrivileges = tablePrivilegeStatements('profiles').join('\n')

        expect(profilePolicy).toContain('id = (SELECT auth.uid())')
        expect(profilePolicy).toContain('JOIN public.league_members AS visible_member')
        expect(profilePolicy).toContain('visible_member.user_id = profiles.id')
        expect(profilePrivileges).toContain('REVOKE SELECT ON public.profiles FROM anon, authenticated')
        expect(profilePrivileges).toContain('GRANT SELECT (')
        expect(profilePrivileges).toContain('updated_at')
        expect(profilePrivileges).toContain('REVOKE SELECT (push_token) ON public.profiles FROM anon, authenticated')

        const authenticatedGrant = profilePrivileges.match(/GRANT SELECT \([^;]*?\) ON public\.profiles TO authenticated;/i)?.[0]
        expect(authenticatedGrant).toEqual(expect.any(String))
        expect(authenticatedGrant).not.toContain('push_token')
    })

    it('does not keep a public username-availability oracle', () => {
        const authSource = readFileSync(path.resolve(__dirname, '../lib/auth.ts'), 'utf8')

        expect(() => latestFunctionDefinition('is_username_available')).toThrow(/dropped after its latest definition/)
        expect(authSource).not.toContain('is_username_available')
    })
})

describe('waiver intent oracle closure', () => {
    it('hides expired uncleared waiver-wire rows from direct league-wide reads', () => {
        const logPolicy = latestPolicyDefinition('waiver_wire_log_select_visible_league_rows', 'waiver_wire_log')

        expect(logPolicy).toContain('league_id IN (SELECT private.my_league_ids())')
        expect(logPolicy).toContain('cleared_at IS NOT NULL')
        expect(logPolicy).toContain('OR clears_at > now()')
        const waiverSource = readFileSync(path.resolve(__dirname, '../lib/waivers.ts'), 'utf8')
        const playerIdsBody = waiverSource.slice(
            waiverSource.indexOf('export async function getWaiverPlayerIdsForSeason'),
            waiverSource.indexOf('export async function submitWaiverClaim'),
        )
        const rosterSource = readFileSync(path.resolve(__dirname, '../lib/roster.ts'), 'utf8')
        const rosterStatusBody = rosterSource.slice(
            rosterSource.indexOf('export async function getPlayerRosterStatus'),
            rosterSource.indexOf('export async function addFreeAgent'),
        )

        expect(playerIdsBody).toContain(".gt('clears_at', now)")
        expect(rosterStatusBody).toContain(".gt('clears_at', now)")
    })

    it('does not branch on hidden pending waiver claims inside client-callable free-agent adds', () => {
        const addBody = latestFunctionDefinition('add_free_agent_atomic')

        expect(addBody).toContain('IF v_waiver_log_id IS NOT NULL THEN')
        expect(addBody).toContain('This player is on waivers - submit a waiver claim instead.')
        expect(addBody).toContain('AND clears_at > now()')
        expect(addBody).not.toContain('FROM waiver_claims')
        expect(addBody).not.toContain("wc.status = 'pending'")
        expect(addBody).not.toContain('SET cleared_at = now()')
    })
})

describe('trade privacy policies', () => {
    it('keeps pending trade rows visible only to the proposing or receiving managers', () => {
        const tradePolicy = latestPolicyDefinition('trades_select_parties_or_accepted', 'trades')
        const visibilityHelper = latestFunctionDefinition('can_read_trade', 'private')

        expect(tradePolicy).toContain('private.can_read_trade(id)')
        expect(visibilityHelper).toContain("trade.status = 'accepted'::public.trade_status")
        expect(visibilityHelper).toContain('OR trade.proposer_member_id IN (SELECT private.my_member_ids())')
        expect(visibilityHelper).toContain('OR trade.recipient_member_id IN (SELECT private.my_member_ids())')
        expect(visibilityHelper).toContain('FROM public.trade_participants AS participant')
        expect(tradePolicy).not.toContain('USING (league_id IN (SELECT private.my_league_ids()))')
    })

    it('applies the same visibility rule to nested trade items', () => {
        const itemPolicy = latestPolicyDefinition('trade_items_select_parties_or_accepted', 'trade_items')
        const visibilityHelper = latestFunctionDefinition('can_read_trade', 'private')

        expect(itemPolicy).toContain('private.can_read_trade(trade_id)')
        expect(visibilityHelper).toContain("trade.status = 'accepted'::public.trade_status")
        expect(visibilityHelper).toContain('OR trade.proposer_member_id IN (SELECT private.my_member_ids())')
        expect(visibilityHelper).toContain('OR trade.recipient_member_id IN (SELECT private.my_member_ids())')
    })
})
