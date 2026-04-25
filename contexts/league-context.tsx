import { createContext, useContext, useState, useEffect, useCallback, ReactNode, useMemo } from 'react'
import { useLeagues, LeagueMembership } from '@/hooks/use-leagues'
import { useAuth } from '@/hooks/use-auth'
import type { LeagueInfo } from '@/types/app'

type LeagueContextType = {
    memberships: LeagueMembership[]
    current: LeagueMembership | null
    currentLeague: LeagueInfo | null
    isCommissioner: boolean
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

    const currentLeague = useMemo(() => current?.leagues ?? null, [current])

    const isCommissioner = useMemo(() => {
        if (!current || !user) return false
        return current.role === 'commissioner' || current.role === 'co_commissioner'
    }, [current, user])

    const setCurrent = useCallback((m: LeagueMembership) => {
        setCurrentId(m.id)
    }, [])

    // Reset when user changes
    useEffect(() => {
        setCurrentId(null)
    }, [user?.id])

    return (
        <LeagueContext.Provider value={{ memberships, current, currentLeague, isCommissioner, setCurrent, loading, refresh }}>
            {children}
        </LeagueContext.Provider>
    )
}

export function useLeagueContext() {
    const ctx = useContext(LeagueContext)
    if (!ctx) throw new Error('useLeagueContext must be used within LeagueProvider')
    return ctx
}
