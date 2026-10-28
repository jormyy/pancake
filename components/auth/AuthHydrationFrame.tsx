import { spacing } from '@/constants/tokens'
import { createContext, type PropsWithChildren, useContext, useLayoutEffect, useState } from 'react'

export const AUTH_DOCUMENT_ID = 'pancake-auth-document'

const AuthRouteReady = createContext<(() => void) | null>(null)
const frameStyle = { flex: 1, display: 'flex', flexDirection: 'column' as const, minHeight: 0, position: 'relative' as const }

export function useAuthRouteReady() {
    const ready = useContext(AuthRouteReady)
    useLayoutEffect(() => { ready?.() }, [ready])
}

export function AuthHydrationFrame({ route, children }: PropsWithChildren<{ route: string | null }>) {
    const [initialRoute] = useState(() => route === 'sign-in' || route === 'sign-up' ? route : null)
    const [documentForm] = useState(() => typeof document === 'undefined' || !!document.getElementById(AUTH_DOCUMENT_ID))
    const [ready, setReady] = useState(false)
    const [markReady] = useState(() => () => setReady(true))
    const pending = documentForm && !ready && initialRoute !== null && route === initialRoute
    useLayoutEffect(() => {
        if (initialRoute === null) return
        if (!pending) document.getElementById(AUTH_DOCUMENT_ID)?.remove()
        return () => { document.getElementById(AUTH_DOCUMENT_ID)?.remove() }
    }, [pending, initialRoute])
    return (
        <AuthRouteReady.Provider value={markReady}>
            <div style={frameStyle} aria-busy={pending}>
                <div style={{ ...frameStyle, ...(pending ? { position: 'absolute' as const, inset: spacing.none, visibility: 'hidden' as const } : {}) }} inert={pending}>
                    {children}
                </div>
            </div>
        </AuthRouteReady.Provider>
    )
}
