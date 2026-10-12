import type { Session } from '@supabase/supabase-js'

export type StoredAuthState = {
    session: Session | null
    status: 'valid' | 'expired' | 'invalid' | 'missing' | 'unavailable'
}

export function authStorageKey(projectUrl: string): string {
    return `sb-${new URL(projectUrl).hostname.split('.')[0]}-auth-token`
}

// This checks the scope and lifetime of a session previously saved by the
// auth client. It does not verify a JWT signature or replace server auth.
export function inspectSession(value: unknown, projectUrl: string, now = Date.now()): StoredAuthState {
    if (value == null) return { session: null, status: 'missing' }
    try {
        const session = value as Session
        if (typeof session.access_token !== 'string' || typeof session.refresh_token !== 'string'
            || !session.refresh_token || session.token_type !== 'bearer'
            || typeof session.user?.id !== 'string' || !session.user.id || session.user.aud !== 'authenticated'
            || !Number.isFinite(session.expires_at)) throw new Error('Invalid session shape')
        const parts = session.access_token.split('.')
        if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('Invalid token')
        const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')))
        if (header.typ !== 'JWT' || typeof header.alg !== 'string' || header.alg.toLowerCase() === 'none') throw new Error('Invalid token header')
        const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
        const claims = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')))
        const issuer = new URL('auth/v1', projectUrl.replace(/\/?$/, '/')).href
        if (claims.iss !== issuer || claims.sub !== session.user.id
            || claims.aud !== 'authenticated' || claims.role !== 'authenticated'
            || !Number.isFinite(claims.iat) || claims.iat * 1000 > now + 60_000
            || !Number.isFinite(claims.exp) || claims.exp <= claims.iat || claims.exp !== session.expires_at) throw new Error('Invalid session scope')
        if (claims.exp * 1000 <= now) return { session: null, status: 'expired' }
        return { session, status: 'valid' }
    } catch {
        return { session: null, status: 'invalid' }
    }
}

export function readStoredAuth(storage: Pick<Storage, 'getItem'>, projectUrl: string): StoredAuthState {
    try {
        const raw = storage.getItem(authStorageKey(projectUrl))
        if (raw === null) return { session: null, status: 'missing' }
        try { return inspectSession(JSON.parse(raw), projectUrl) }
        catch { return { session: null, status: 'invalid' } }
    } catch {
        return { session: null, status: 'unavailable' }
    }
}
