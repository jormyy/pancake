import { describe, expect, it } from 'vitest'
import { read } from './source-guard'

// Permanent regression guards for abuse cases confirmed closed during the
// security convergence pass (see validation/security-report.md). Each guard
// pins the load-bearing SQL so a future migration can't silently reopen the
// hole. Live attacks proved these deny; these tests prove the guard stays.

describe('security regression guards', () => {
    it('protects the push_token column from client reads', () => {
        const migration = read('supabase/migrations/20260516290001_protect_push_token_column.sql')
        expect(migration).toContain('REVOKE SELECT (push_token) ON public.profiles FROM authenticated;')
        expect(migration).toContain('REVOKE SELECT (push_token) ON public.profiles FROM anon;')
    })

    it('keeps realtime-published tables RLS-gated to the acting member league', () => {
        // Realtime respects RLS: a table added to the publication with no
        // league-scoped SELECT policy would stream every league's rows to any
        // subscriber. Pin both the publication membership and the policy.
        const draftRealtime = read('supabase/migrations/20260513000001_enable_draft_realtime.sql')
        for (const table of ['drafts', 'draft_budgets', 'nominations', 'bids']) {
            expect(draftRealtime).toContain(`ALTER PUBLICATION supabase_realtime ADD TABLE public.${table};`)
        }
        const matchupsRealtime = read('supabase/migrations/20260512000012_enable_matchups_realtime.sql')
        expect(matchupsRealtime).toContain('ALTER PUBLICATION supabase_realtime ADD TABLE public.matchups;')

        const bidsPolicy = read('supabase/migrations/20260328000005_schema_improvements.sql')
        expect(bidsPolicy).toContain('CREATE POLICY "bids_select" ON bids')
        const matchupsPolicy = read('supabase/migrations/20260422000001_matchups_rls.sql')
        expect(matchupsPolicy).toContain('USING (league_id IN (SELECT private.my_league_ids()))')
    })

    it('join-by-invite gives a generic error that is not an existence oracle', () => {
        // Wrong / malformed / nonexistent codes all resolve to the same
        // "League not found" message so codes can't be enumerated.
        const joinRpc = read('supabase/migrations/20260516350000_join_league_status_gate.sql')
        expect(joinRpc).toContain('League not found. Check your invite code.')
    })

    it('generates invite codes server-side only (no client RPC grant)', () => {
        const migration = read('supabase/migrations/20260627000016_invite_code_security.sql')
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.generate_invite_code() FROM anon;')
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.generate_invite_code() FROM authenticated;')
    })
})
