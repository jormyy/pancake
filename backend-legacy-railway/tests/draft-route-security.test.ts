import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const draftRoutes = readFileSync(path.resolve(__dirname, '../src/routes/draft.ts'), 'utf8')
const authz = readFileSync(path.resolve(__dirname, '../src/lib/authz.ts'), 'utf8')

// Regression for the removed draft-state IDOR: GET /draft/:draftId and
// /draft/:draftId/rookie-state read private draft state (budgets/bids/picks)
// with the service-role client (bypassing RLS) and no membership check.
// Draft state is read client-side through the per-user RLS Supabase client; no
// backend draft-state GET route may exist, and every draft mutation route must
// carry an authorization guard.

const AUTHZ = ['requireCommissioner', 'requireCommissionerForDraft', 'verifyMemberAccess', 'verifyOwnMember']

describe('draft route authorization (no service-role IDOR)', () => {
    it('exposes no backend GET draft-state route (state is read via RLS client-side)', () => {
        expect(draftRoutes).not.toMatch(/app\.get\s*\(/)
    })

    it('does not import the removed service-role draft-state readers', () => {
        expect(draftRoutes).not.toMatch(/\bgetDraftState\b/)
        expect(draftRoutes).not.toMatch(/\bgetRookieDraftState\b/)
    })

    it('every draft route handler enforces an authorization guard', () => {
        // Split the file into per-route segments (each app.post(...) block).
        const segments = draftRoutes.split(/app\.post\s*\(/).slice(1)
        expect(segments.length).toBeGreaterThan(0)
        for (const seg of segments) {
            const pathMatch = seg.match(/['"`](\/[^'"`]*)['"`]/)
            const routePath = pathMatch ? pathMatch[1] : '(unknown)'
            const hasGuard = AUTHZ.some((g) => seg.includes(`${g}(`))
            expect(hasGuard, `draft route ${routePath} has no authz guard (${AUTHZ.join('/')})`).toBe(true)
        }
    })

    it('requires member ownership for manager-consent draft actions', () => {
        for (const route of ['nominate', 'bid', 'withdraw-nomination', 'auto-pick', 'snake-pick']) {
            expect(draftRoutes).toMatch(new RegExp(`/${route}[\\s\\S]*?verifyOwnMember\\(req\\.userId, memberId\\)`))
        }
    })

    it('scopes nomination withdrawal by the route draft id before service-role mutation', () => {
        const withdrawRoute = draftRoutes.slice(
            draftRoutes.indexOf("'/:draftId/withdraw-nomination'"),
            draftRoutes.indexOf("app.post('/start-rookie'"),
        )

        expect(withdrawRoute).toContain('const { draftId } = req.params')
        expect(withdrawRoute).toContain('withdrawNomination(draftId, memberId, nominationId, req.userId)')
    })

    it('does not reveal draft IDs outside commissioner-visible leagues', () => {
        const fnBody = authz.slice(
            authz.indexOf('export async function requireCommissionerForDraft'),
            authz.indexOf('/**\n * Verify the requesting user owns the member record', authz.indexOf('export async function requireCommissionerForDraft')),
        )

        expect(fnBody).toContain(".from('league_members')")
        expect(fnBody).toContain(".eq('user_id', userId)")
        expect(fnBody).toContain(".in('role', ['commissioner', 'co_commissioner'])")
        expect(fnBody).toContain('commissionerLeagueIds')
        expect(fnBody).toContain(".from('drafts')")
        expect(fnBody).toContain(".eq('id', draftId)")
        expect(fnBody).toContain(".in('league_id', commissionerLeagueIds)")
        expect(fnBody).toContain('.maybeSingle()')
        expect(fnBody).not.toContain('await requireCommissioner(userId, data.league_id)')
    })
})
