import React from 'react'
import { renderToString } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from '@/hooks/use-auth'
import { authSession, inspectFixtureSession } from '../helpers/auth-session'

const stored = vi.hoisted(() => ({ session: null as unknown }))

vi.mock('@/lib/supabase', () => ({
    readStoredAuthState: () => inspectFixtureSession(stored.session),
    inspectAuthSession: (session: unknown) => inspectFixtureSession(session),
    supabaseAuthStorageKey: 'sb-auth-fixture-auth-token',
    supabase: { auth: {} },
}))
vi.mock('@/lib/persistent-cache', () => ({ clearPersistentCaches: vi.fn() }))

it.each(['valid', 'expired', 'invalid'] as const)('uses the server auth snapshot while hydrating %s browser storage', status => {
    stored.session = status === 'invalid' ? {} : authSession('owner', Math.floor(Date.now() / 1000) + (status === 'expired' ? -60 : 3600))
    let snapshot: unknown
    function Form() {
        const { user, loading, restorationStatus } = useAuth()
        snapshot = { user: user?.id ?? null, loading, restorationStatus }
        return React.createElement('form')
    }
    renderToString(React.createElement(AuthProvider, null, React.createElement(Form)))
    expect(snapshot).toEqual({ user: null, loading: true, restorationStatus: 'missing' })
})
