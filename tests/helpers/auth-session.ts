import { inspectSession } from '@/lib/auth-session'
export const fixtureProject = 'http://auth-fixture.test'
export function authSession(userId: string, expiresAt = Math.floor(Date.now() / 1000) + 3600) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    return {
        user: { id: userId, aud: 'authenticated' }, token_type: 'bearer', refresh_token: 'local-fixture-refresh',
        expires_at: expiresAt,
        access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: fixtureProject + '/auth/v1', sub: userId, aud: 'authenticated', role: 'authenticated', exp: expiresAt, iat: expiresAt - 3600 })}.Zml4dHVyZQ`,
    }
}
export const inspectFixtureSession = (value: unknown) => inspectSession(value, fixtureProject)
