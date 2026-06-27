import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const draftRoutes = readFileSync(path.resolve(__dirname, '../src/routes/draft.ts'), 'utf8')

// Regression for the removed draft-state IDOR: GET /draft/:draftId and
// /draft/:draftId/rookie-state read private draft state (budgets/bids/picks)
// with the service-role client (bypassing RLS) and no membership check.
// Draft state is read client-side through the per-user RLS Supabase client; no
// backend draft-state GET route may exist, and every draft mutation route must
// carry an authorization guard.

const AUTHZ = ['requireCommissioner', 'requireCommissionerForDraft', 'verifyMemberAccess']

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
})
