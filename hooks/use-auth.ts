import { useEffect, useState } from 'react'
import { AppState, AppStateStatus } from 'react-native'
import { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

export function useAuth() {
    const [session, setSession] = useState<Session | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session)
            setLoading(false)
        })

        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session)
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
            subscription.unsubscribe()
            appStateSub.remove()
        }
    }, [])

    return {
        session,
        user: session?.user ?? null,
        loading,
    }
}
