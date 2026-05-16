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

    // Derive current from memberships so it always reflects fresh data.
    // Memoize on [memberships, currentId] so the reference is stable across
    // unrelated parent re-renders — otherwise every consumer effect that depends
    // on `current` refires on each render.
    const current = useMemo(
        () => memberships.find((m) => m.id === currentId) ?? memberships[0] ?? null,
        [memberships, currentId],
    )

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

    // Memoize context value so consumers don't tear / re-render on every parent tick.
    const value = useMemo<LeagueContextType>(
        () => ({ memberships, current, currentLeague, isCommissioner, setCurrent, loading, refresh }),
        [memberships, current, currentLeague, isCommissioner, setCurrent, loading, refresh],
    )

    return <LeagueContext.Provider value={value}>{children}</LeagueContext.Provider>
}

export function useLeagueContext() {
    const ctx = useContext(LeagueContext)
    if (!ctx) throw new Error('useLeagueContext must be used within LeagueProvider')
    return ctx
}
