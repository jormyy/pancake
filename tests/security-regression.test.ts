import { describe, expect, it } from 'vitest'
import {
    functionPrivilegeStatements,
    latestFunctionDefinition,
    latestPolicyDefinition,
    tablePrivilegeStatements,
} from './source-guard'

// Permanent regression guards for abuse cases confirmed closed during the
// security convergence pass (see validation/security-report.md). Applied
// migrations are immutable, so pinning a single historical file cannot catch a
// *later* migration that reopens the hole. Each guard therefore checks the
// current effective state across the whole migration set: the protection must
// exist and nothing after it may re-grant / re-expose.

describe('security regression guards', () => {
    it('never re-grants the push_token column to client roles', () => {
        // The protecting REVOKEs must be present, and nothing after them may
        // re-expose the column — either an explicit GRANT SELECT (push_token)
        // or a whole-table GRANT SELECT ON profiles (which includes the column).
        // Strip SQL line comments first so doc text can't false-match.
        const stripComments = (s: string) => s.replace(/--[^\n]*/g, '')
        const profileGrants = tablePrivilegeStatements('profiles').map(stripComments)
        expect(profileGrants.some((s) => /REVOKE\s+SELECT\s*\(\s*push_token\s*\)[\s\S]*FROM[\s\S]*authenticated/i.test(s))).toBe(true)
        expect(profileGrants.some((s) => /REVOKE\s+SELECT\s*\(\s*push_token\s*\)[\s\S]*FROM[\s\S]*\banon\b/i.test(s))).toBe(true)
        const reExposesPushToken = profileGrants.some((s) => {
            if (!/^\s*GRANT\b/i.test(s) || !/\b(anon|authenticated)\b/i.test(s)) return false
            // explicit column grant, or an unqualified whole-table SELECT grant
            if (/GRANT[\s\S]*SELECT\s*\([^)]*\bpush_token\b/i.test(s)) return true
            return /GRANT\s+SELECT\s+ON\b/i.test(s) // no column list = whole row incl. push_token
        })
        expect(reExposesPushToken).toBe(false)
    })

    it('keeps realtime-published tables RLS-gated to the acting member league', () => {
        // Realtime respects RLS; a published table without a league-scoped
        // SELECT policy streams every league's rows. Pin the current policy
        // definitions (latest wins) rather than one historical migration.
        const bidsPolicy = latestPolicyDefinition('bids_select', 'bids')
        expect(bidsPolicy).toMatch(/league_id\b/)
        const nominationsPolicy = latestPolicyDefinition('nominations_select', 'nominations')
        expect(nominationsPolicy).toMatch(/league_id\b/)
        const matchupsPolicy = latestPolicyDefinition('matchups_select', 'matchups')
        expect(matchupsPolicy).toContain('my_league_ids()')
    })

    it('never re-grants invite-code generation to client roles after the lockdown', () => {
        // No migration from the lockdown onward may GRANT EXECUTE on
        // generate_invite_code to anon/authenticated.
        const grants = functionPrivilegeStatements('generate_invite_code')
        expect(grants.some((s) => /REVOKE\s+ALL.*FROM\s+anon/is.test(s))).toBe(true)
        expect(grants.some((s) => /REVOKE\s+ALL.*FROM\s+authenticated/is.test(s))).toBe(true)
        const reGrantsToClient = grants.some(
            (s) => /^GRANT\s+EXECUTE/i.test(s.trim()) && /\b(anon|authenticated)\b/i.test(s),
        )
        expect(reGrantsToClient).toBe(false)
    })

    it('keeps join-by-invite errors generic (no existence oracle)', () => {
        // The CURRENT join RPC definition (latest-wins) must reject wrong codes
        // with the generic message, so codes can't be enumerated. Guarding the
        // latest definition — not any historical file — fails if a future
        // migration redefines the RPC with a code-existence oracle.
        const joinRpc = latestFunctionDefinition('join_league_by_invite_code')
        expect(joinRpc).toContain('League not found. Check your invite code.')
    })

    it('holds the anon-write lockdown: no migration grants INSERT/UPDATE/DELETE to anon on gameplay tables', () => {
        const gameplayTables = ['roster_players', 'trades', 'waiver_claims', 'faab_balances', 'draft_picks', 'standings', 'matchups']
        for (const table of gameplayTables) {
            const anonWrite = tablePrivilegeStatements(table).some(
                (s) => /^GRANT\b/i.test(s.trim()) && /\b(INSERT|UPDATE|DELETE)\b/i.test(s) && /\banon\b/i.test(s),
            )
            expect(anonWrite, `anon must have no write grant on ${table}`).toBe(false)
        }
    })
})
