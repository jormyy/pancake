import { createContext, createElement, ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import { AppState, AppStateStatus } from 'react-native'
import { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { clearPersistentCaches } from '@/lib/persistent-cache'

type AuthContextValue = {
    session: Session | null
    user: Session['user'] | null
    loading: boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
    const [session, setSession] = useState<Session | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        let active = true
        let authEventSequence = 0
        let cacheOwnerId: string | null = null

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
                commitSession(null)
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
