import { describe, expect, it } from 'vitest'
import {
    latestFunctionDefinition,
    latestPolicyDefinition,
    read,
} from './source-guard'

describe('league management deletion', () => {
    it('soft-deletes leagues through an audited commissioner-only RPC', () => {
        const migration = read('supabase/migrations/20260630000007_league_deletion.sql')
        const deleteBody = latestFunctionDefinition('delete_league_atomic')

        expect(migration).toContain('ADD COLUMN IF NOT EXISTS deleted_at')
        expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.league_audit_logs')
        expect(deleteBody).toContain('v_actor_user_id uuid := (SELECT auth.uid())')
        expect(deleteBody).toContain("member.role IN ('commissioner', 'co_commissioner')")
        expect(deleteBody).toContain("status = 'archived'")
        expect(deleteBody).toContain('deleted_at = now()')
        expect(deleteBody).toContain("action, metadata")
        expect(deleteBody).toContain("'delete'")
        expect(deleteBody).toContain("status IN ('pending', 'in_progress', 'paused')")
        expect(deleteBody).toContain('pause_reason = NULL')
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.delete_league_atomic(uuid) FROM PUBLIC, anon, authenticated')
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.delete_league_atomic(uuid) TO authenticated')
    })

    it('removes deleted leagues from normal client-visible league scopes', () => {
        const myLeaguesBody = latestFunctionDefinition('my_league_ids', 'private')
        const myMembersBody = latestFunctionDefinition('my_member_ids', 'private')
        const leaguePolicy = latestPolicyDefinition('leagues_select', 'leagues')

        expect(myLeaguesBody).toContain('JOIN public.leagues AS league')
        expect(myLeaguesBody).toContain('league.deleted_at IS NULL')
        expect(myMembersBody).toContain('JOIN public.leagues AS league')
        expect(myMembersBody).toContain('league.deleted_at IS NULL')
        expect(leaguePolicy).toContain('deleted_at IS NULL')
        expect(leaguePolicy).toContain('id IN (SELECT private.my_league_ids())')
    })

    it('filters deleted leagues in the app and hides destructive controls from non-commissioners', () => {
        const leagueSource = read('lib/league.ts')
        const settingsSource = read('app/(modals)/commissioner-settings.tsx')
        const appTypes = read('types/app.ts')
        const databaseTypes = read('types/database.ts')

        expect(leagueSource).toContain('leagues!league_members_league_id_fkey!inner')
        expect(leagueSource).toContain(".is('leagues.deleted_at', null)")
        expect(leagueSource).toContain('export async function deleteLeague')
        expect(settingsSource).toContain('deleteLeague')
        expect(settingsSource).toContain('DANGER ZONE')
        expect(settingsSource).toContain('{isCommissioner ? (')
        expect(appTypes).toContain('deleted_at?: string | null')
        expect(databaseTypes).toContain('league_audit_logs')
        expect(databaseTypes).toContain('delete_league_atomic')
    })
})
