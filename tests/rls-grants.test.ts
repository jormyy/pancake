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

const ANON_SELECT_TABLE_ALLOWLIST = new Set([
    'dynasty_news',
    'dynasty_rankings',
    'nba_games',
    'player_game_stats',
    'players',
    'season_weeks',
])

const allMigrationSql = (): string =>
    readdirSync(MIGRATIONS)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => readFileSync(path.join(MIGRATIONS, f), 'utf8'))
        .join('\n')

function finalAnonSelectTables(sql: string): string[] {
    const selectedTables = new Set<string>()
    const statementPattern = /\b(GRANT|REVOKE)\s+SELECT\s+ON\s+TABLE\s+(?:"public"\."([^"]+)"|public\.([a-z_][a-z0-9_]*))\s+(TO|FROM)\s+([^;]+);/gi
    for (const match of sql.matchAll(statementPattern)) {
        const action = match[1].toUpperCase()
        const table = match[2] ?? match[3]
        const roles = match[5].toLowerCase()
        if (!/\banon\b/.test(roles)) continue
        if (action === 'GRANT') selectedTables.add(table)
        else selectedTables.delete(table)
    }
    return [...selectedTables].sort()
}

describe('service-role-only RPCs are never granted to client roles', () => {
    const sql = allMigrationSql()

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

    it('keeps anon table reads limited to public reference data', () => {
        const finalAnonTables = finalAnonSelectTables(sql)

        expect(finalAnonTables).toEqual([...ANON_SELECT_TABLE_ALLOWLIST].sort())
    })
})

describe('storage policy restoration', () => {
    const sql = allMigrationSql()

    it.each(['avatars_read_public', 'avatars_insert_own', 'avatars_update_own', 'avatars_delete_own'])(
        'restores %s after the remote snapshot',
        (policy) => {
            expect(sql.lastIndexOf(`CREATE POLICY "${policy}" ON storage.objects`)).toBeGreaterThan(
                sql.lastIndexOf(`drop policy "${policy}" on "storage"."objects"`),
            )
        },
    )
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
        expect(profilePrivileges).toContain('REVOKE SELECT (push_token_revocation_hash) ON public.profiles FROM PUBLIC, anon, authenticated')
        expect(profilePrivileges).toContain('REVOKE UPDATE (push_token_revocation_hash) ON public.profiles FROM PUBLIC, anon, authenticated')

        const authenticatedGrant = profilePrivileges.match(/GRANT SELECT \([^;]*?\) ON public\.profiles TO authenticated;/i)?.[0]
        expect(authenticatedGrant).toEqual(expect.any(String))
        expect(authenticatedGrant).not.toContain('push_token')
        expect(authenticatedGrant).not.toContain('push_token_revocation_hash')
    })

    it('does not keep a public username-availability oracle', () => {
        const authSource = readFileSync(path.resolve(__dirname, '../lib/auth.ts'), 'utf8')

        expect(() => latestFunctionDefinition('is_username_available')).toThrow(/dropped after its latest definition/)
        expect(authSource).not.toContain('is_username_available')
    })

    it('keeps the auth profile trigger function non-executable outside its trigger', () => {
        const privileges = functionPrivilegeStatements('handle_new_auth_user').join('\n').replace(/\s+/g, ' ')

        expect(privileges).toContain(
            'REVOKE ALL ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated, service_role',
        )
    })

    it('keeps the legacy push-token compatibility trigger owner-scoped and non-executable', () => {
        const definition = latestFunctionDefinition('normalize_legacy_push_token_write', 'private')
        const privileges = functionPrivilegeStatements('normalize_legacy_push_token_write', 'private')
            .join('\n')
            .replace(/\s+/g, ' ')

        expect(definition).toContain('SECURITY DEFINER')
        expect(definition).toContain("SET search_path = ''")
        expect(definition).toContain('UPDATE public.profiles')
        expect(privileges).toContain(
            'REVOKE ALL ON FUNCTION private.normalize_legacy_push_token_write() FROM PUBLIC, anon, authenticated, service_role',
        )
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
    it('allows authenticated participant reads through RLS without exposing them anonymously', () => {
        const privileges = tablePrivilegeStatements('trade_participants').join('\n')

        expect(privileges).toContain('GRANT SELECT ON public.trade_participants TO authenticated')
        expect(privileges).toContain('REVOKE SELECT ON public.trade_participants FROM anon')
    })

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
