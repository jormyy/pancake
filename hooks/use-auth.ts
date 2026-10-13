import { createContext, createElement, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { isAuthApiError, isAuthSessionMissingError, Session } from '@supabase/supabase-js'
import { inspectAuthSession, readStoredAuthState, supabase, supabaseAuthStorageKey, localAuthChangeEvent } from '@/lib/supabase'
import type { StoredAuthState } from '@/lib/auth-session'
import { clearPersistentCaches } from '@/lib/persistent-cache'
import { setSessionOwner } from '@/lib/session-cache-registry'

type AuthContextValue = {
    session: Session | null
    user: Session['user'] | null
    loading: boolean
    restorationStatus: StoredAuthState['status']
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
    const [restored, setRestored] = useState(readStoredAuthState)
    const initial = useRef(restored)
    const [loading, setLoading] = useState(restored.session === null)

    useEffect(() => {
        let active = true
        let sequence = 0
        let current = initial.current
        let cacheOwnerId = current.session?.user.id ?? current.refreshIdentity?.userId ?? null
        let expiryTimer: ReturnType<typeof setTimeout> | undefined
        let restoring = false
        const online = () => typeof navigator === 'undefined' || navigator.onLine !== false
        const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

        const commit = (next: StoredAuthState, forceClear = false, settled = false) => {
            if (!active) return
            const stored = readStoredAuthState()
            if (stored.status === 'unavailable') next = stored
            else if (next.session && stored.session?.access_token !== next.session.access_token) next = stored
            else if (!next.session && stored.session) next = stored
            else if (!next.session && next.status === 'missing' && ['expired', 'invalid'].includes(stored.status)) next = stored
            else if (!next.session && next.status === 'expired' && stored.status === 'expired') next = stored
            // The SDK removes a rejected refresh before publishing SIGNED_OUT.
            if (next.status === 'missing' && current.status === 'expired') next = { session: null, status: 'expired' }
            clearTimeout(expiryTimer)
            const pending = !settled && next.status === 'expired' && !!next.refreshIdentity && online()
            const nextOwner = next.session?.user.id ?? (pending ? next.refreshIdentity?.userId ?? null : null)
            if (forceClear || (cacheOwnerId !== null && cacheOwnerId !== nextOwner)) clearPersistentCaches()
            cacheOwnerId = nextOwner
            setSessionOwner(next.session?.user.id ?? null)
            current = next
            setRestored(next)
            setLoading(pending)
            if (next.session?.expires_at) {
                expiryTimer = setTimeout(() => {
                    const checked = inspectAuthSession(current.session)
                    if (!checked.session) sequence += 1
                    commit(checked)
                    if (!checked.session) void restore()
                }, Math.min(2_147_483_647, Math.max(0, next.session.expires_at * 1000 - Date.now())))
            }
        }

        const restore = async () => {
            if (!active || restoring || !online() || !visible()) return
            restoring = true
            const started = sequence
            try {
                const { data: { session }, error } = await supabase.auth.getSession()
                if (error) throw error
                if (active && sequence === started) commit(inspectAuthSession(session), false, true)
            } catch (error) {
                if (!active || sequence !== started) return
                console.error('Could not restore the authenticated session.', error)
                const rejected = isAuthSessionMissingError(error)
                    || (isAuthApiError(error) && [400, 401, 403, 404].includes(error.status))
                const checked = inspectAuthSession(current.session)
                commit(checked.session ? checked : { session: null, status: current.status === 'expired' ? 'expired' : 'unavailable' }, false, rejected)
            } finally {
                restoring = false
                // Resume/account events can invalidate a pending read. Restore the latest storage next.
                if (active && sequence !== started && current.refreshIdentity) void restore()
            }
        }

        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            const next = inspectAuthSession(session)
            // A late initial/refresh event cannot restore another stored owner.
            const stored = readStoredAuthState()
            if (next.session && stored.status !== 'unavailable'
                && stored.session?.access_token !== next.session.access_token) return
            if (!next.session && (stored.session || (stored.refreshIdentity && next.status === 'missing'))) return
            sequence += 1
            commit(next, event === 'SIGNED_OUT')
        })

        commit(current)
        void restore()

        const resume = () => {
            sequence += 1
            const stored = readStoredAuthState()
            commit(stored)
            if (visible()) {
                supabase.auth.startAutoRefresh()
                void restore()
            } else {
                supabase.auth.stopAutoRefresh()
            }
        }
        const storageChanged = (event: StorageEvent) => {
            if (event.key === null || event.key === supabaseAuthStorageKey || event.key === `${supabaseAuthStorageKey}-local-logout`) resume()
        }
        if (typeof window !== 'undefined') {
            window.addEventListener(localAuthChangeEvent, resume)
            window.addEventListener('online', resume)
            window.addEventListener('pageshow', resume)
            window.addEventListener('focus', resume)
            window.addEventListener('storage', storageChanged)
            document.addEventListener('visibilitychange', resume)
        }
        return () => {
            active = false
            sequence += 1
            clearTimeout(expiryTimer)
            subscription.unsubscribe()
            if (typeof window !== 'undefined') {
                window.removeEventListener(localAuthChangeEvent, resume)
                window.removeEventListener('online', resume)
                window.removeEventListener('pageshow', resume)
                window.removeEventListener('focus', resume)
                window.removeEventListener('storage', storageChanged)
                document.removeEventListener('visibilitychange', resume)
            }
        }
    }, [])

    const value = useMemo(() => ({
        session: restored.session,
        user: restored.session?.user ?? null,
        loading,
        restorationStatus: restored.status,
    }), [restored, loading])

    return createElement(AuthContext.Provider, { value }, children)
}

export function useAuth() {
    const ctx = useContext(AuthContext)
    if (!ctx) throw new Error('useAuth must be used within AuthProvider')
    return ctx
}
