import { createContext, createElement, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, AppStateStatus } from 'react-native'
import { Session } from '@supabase/supabase-js'
import { readStoredSessionSync, supabase } from '@/lib/supabase'
import { clearPersistentCaches } from '@/lib/persistent-cache'

type AuthContextValue = {
    session: Session | null
    user: Session['user'] | null
    loading: boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
    // Seed from the persisted session (web localStorage) so the first render
    // already has user.id — persistent caches key on it, and without this every
    // refresh blanks the app until the async getSession() resolves.
    const [session, setSession] = useState<Session | null>(() => readStoredSessionSync())
    const [loading, setLoading] = useState(session === null)
    const seededUserId = useRef(session?.user.id ?? null)

    useEffect(() => {
        let active = true
        let authEventSequence = 0
        let cacheOwnerId: string | null = seededUserId.current

        const commitSession = (nextSession: Session | null, forceCacheClear = false) => {
            if (!active) return
            const nextOwnerId = nextSession?.user.id ?? null
            if (forceCacheClear || (cacheOwnerId !== null && cacheOwnerId !== nextOwnerId)) {
                clearPersistentCaches()
            }
            cacheOwnerId = nextOwnerId
            setSession(nextSession)
            setLoading(false)
        }

        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange((event, session) => {
            authEventSequence += 1
            commitSession(session, event === 'SIGNED_OUT')
        })

        const bootstrapSequence = authEventSequence
        void supabase.auth.getSession()
            .then(({ data: { session }, error }) => {
                if (error) throw error
                if (authEventSequence === bootstrapSequence) commitSession(session)
            })
            .catch((error) => {
                if (!active || authEventSequence !== bootstrapSequence) return
                console.error('Could not restore the authenticated session.', error)
                // A transient failure (offline boot, slow network) must not log
                // the user out of the seeded session — keep it and let the next
                // successful refresh or an explicit SIGNED_OUT settle the truth.
                if (seededUserId.current === null) commitSession(null)
                else setLoading(false)
            })

        // Restart auto-refresh when the app returns from background so the
        // JWT is always valid when the user resumes the app.
        const appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
            if (state === 'active') {
                supabase.auth.startAutoRefresh()
            } else {
                supabase.auth.stopAutoRefresh()
            }
        })

        return () => {
            active = false
            subscription.unsubscribe()
            appStateSub.remove()
        }
    }, [])

    const value = useMemo(() => ({
        session,
        user: session?.user ?? null,
        loading,
    }), [session, loading])

    return createElement(AuthContext.Provider, { value }, children)
}

export function useAuth() {
    const ctx = useContext(AuthContext)
    if (!ctx) {
        throw new Error('useAuth must be used within AuthProvider')
    }
    return ctx
}
