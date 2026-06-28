import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

vi.mock('../src/lib/supabase', () => ({
    supabase: {
        from: vi.fn(),
        auth: { getUser: vi.fn() },
    },
}))

import { supabase } from '../src/lib/supabase'
import { buildApp } from '../src/app'
import healthRoutes from '../src/routes/health'
import { getSupabaseAdminKeyMode } from '../src/lib/supabaseKeyMode'

const appSource = readFileSync(path.resolve(__dirname, '../src/app.ts'), 'utf8')
const healthSource = readFileSync(path.resolve(__dirname, '../src/routes/health.ts'), 'utf8')
const authzSource = readFileSync(path.resolve(__dirname, '../src/lib/authz.ts'), 'utf8')
const rosterSource = readFileSync(path.resolve(__dirname, '../src/services/roster.ts'), 'utf8')
const mockFrom = vi.mocked(supabase.from)

beforeEach(() => {
    vi.clearAllMocks()
})

function failedSupabaseQuery(error: unknown) {
    const result = { data: null, error }
    const chain: any = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        order: vi.fn(() => chain),
        then: (resolve: (value: unknown) => unknown, reject: (value: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject),
    }
    return chain
}

describe('backend public security boundaries', () => {
    it('installs the generic error handler at the root Fastify scope', async () => {
        expect(appSource).toContain('await errorHandlerPlugin(app)')
        expect(appSource).not.toContain('app.register(errorHandlerPlugin)')

        mockFrom.mockReturnValue(failedSupabaseQuery({
            code: '42703',
            message: 'column private_token does not exist',
            details: 'raw planner detail with table internals',
            hint: 'raw hint',
        }) as any)

        const app = await buildApp()
        const response = await app.inject({ method: 'GET', url: '/games/today' })
        await app.close()

        expect(response.statusCode).toBe(500)
        expect(response.json()).toMatchObject({ ok: false, error: 'Internal server error' })
        expect(response.body).not.toContain('private_token')
        expect(response.body).not.toContain('raw planner detail')
        expect(response.body).not.toContain('raw hint')
    })

    it('does not expose secret-key posture on public health checks', async () => {
        const app = Fastify({ logger: false })
        await app.register(healthRoutes)

        const response = await app.inject({ method: 'GET', url: '/health' })
        await app.close()

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({ status: 'ok' })
        expect(healthSource).not.toContain('supabaseAdminKeyMode')
        expect(healthSource).not.toContain('getSupabaseAdminKeyMode')
    })

    it('rejects legacy service-role JWTs for backend admin access', () => {
        expect(getSupabaseAdminKeyMode({ PANCAKE_SUPABASE_SECRET_KEY: 'sb_secret_test' } as any)).toBe('modern-secret')
        expect(getSupabaseAdminKeyMode({ SUPABASE_SECRET_KEY: 'legacy-service-role-jwt' } as any)).toBe('legacy-service-role')
        expect(getSupabaseAdminKeyMode({} as any)).toBe('missing')
    })

    it('does not exempt bad E2E admin-secret guesses from rate limiting', () => {
        const allowListStart = appSource.indexOf('allowList: (req) =>')
        const allowListEnd = appSource.indexOf('})', allowListStart)
        const allowListBody = appSource.slice(allowListStart, allowListEnd)

        expect(appSource).toContain('max: 100')
        expect(appSource).not.toContain('max: process.env.ENABLE_E2E_ROUTES')
        expect(allowListBody).toContain("req.url.startsWith('/e2e/')")
        expect(allowListBody).toContain("req.headers['x-e2e-secret'] === process.env.E2E_ADMIN_SECRET")
    })

    it('does not expose whether a foreign member id exists', () => {
        const ownMemberBody = authzSource.slice(
            authzSource.indexOf('export async function requireOwnMember'),
            authzSource.indexOf('export async function verifyOwnMember'),
        )
        const memberAccessBody = authzSource.slice(
            authzSource.indexOf('export async function verifyMemberAccess'),
            authzSource.indexOf('/**\n * Verify the requesting user owns the member record', authzSource.indexOf('export async function verifyMemberAccess')),
        )
        const sameLeagueBody = authzSource.slice(
            authzSource.indexOf('export async function verifySameLeague'),
            authzSource.indexOf('export function requireAdmin'),
        )

        expect(ownMemberBody).toContain(".eq('id', memberId)")
        expect(ownMemberBody).toContain(".eq('user_id', userId)")
        expect(ownMemberBody).toContain('.maybeSingle()')
        expect(ownMemberBody).not.toContain("data.user_id !== userId")
        expect(memberAccessBody).toContain("throw new NotFoundError('Member not found')")
        expect(memberAccessBody).not.toContain("throw new AppError('Access denied', 403)")
        expect(sameLeagueBody).toContain("if (!requesterInLeague) throw new NotFoundError('Member not found')")
        expect(sameLeagueBody).not.toContain("Not a member of this league")
    })

    it('does not expose whether a foreign roster player id exists', () => {
        const rosterUnlockBody = rosterSource.slice(
            rosterSource.indexOf('async function assertRosterToggleUnlocked'),
            rosterSource.indexOf('const team = rosterPlayer.players?.nba_team'),
        )

        expect(rosterUnlockBody).toContain(".eq('id', rosterPlayerId)")
        expect(rosterUnlockBody).toContain(".eq('league_members.user_id', userId)")
        expect(rosterUnlockBody).toContain('.maybeSingle()')
        expect(rosterUnlockBody).toContain("throw new NotFoundError('Roster player not found')")
        expect(rosterUnlockBody).not.toContain('Not authorized to modify this roster player')
        expect(rosterUnlockBody).not.toContain("rosterPlayer.league_members?.user_id !== userId")
    })
})
