import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { useLeagues, LeagueMembership } from '@/hooks/use-leagues'
import { useAuth } from '@/hooks/use-auth'

type LeagueContextType = {
    memberships: LeagueMembership[]
    current: LeagueMembership | null
    setCurrent: (m: LeagueMembership) => void
    loading: boolean
    refresh: () => void
}

const LeagueContext = createContext<LeagueContextType | null>(null)

export function LeagueProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth()
    const { memberships, loading, refresh } = useLeagues()
    const [currentId, setCurrentId] = useState<string | null>(null)

    // Derive current from memberships so it always reflects fresh data
    const current = memberships.find((m) => m.id === currentId) ?? memberships[0] ?? null

    const setCurrent = useCallback((m: LeagueMembership) => {
        setCurrentId(m.id)
    }, [])

    // Reset when user changes
    useEffect(() => {
        setCurrentId(null)
    }, [user?.id])

    return (
        <LeagueContext.Provider value={{ memberships, current, setCurrent, loading, refresh }}>
            {children}
        </LeagueContext.Provider>
    )
}

export function useLeagueContext() {
    const ctx = useContext(LeagueContext)
    if (!ctx) throw new Error('useLeagueContext must be used within LeagueProvider')
    return ctx
}
