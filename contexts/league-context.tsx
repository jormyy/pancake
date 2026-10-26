import { PlayerEligibilityContext } from '@/contexts/player-eligibility-context'
import { createContext, useContext, useState, useEffect, useCallback, useMemo, type PropsWithChildren } from 'react'
import { useLeagues, LeagueMembership } from '@/hooks/use-leagues'
import { useAuth } from '@/hooks/use-auth'
import { useMemberClaimsStream } from '@/hooks/use-member-claims-stream'
import { useLeagueChangeStream } from '@/hooks/use-league-change-stream'
import { readPersistentCache, removePersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import type { LeagueInfo } from '@/types/app'

type LeagueContextType = {
    memberships: LeagueMembership[]
    current: LeagueMembership | null
    currentLeague: LeagueInfo | null
    isCommissioner: boolean
    setCurrent: (m: LeagueMembership) => void
    loading: boolean
    membershipStatus: ReturnType<typeof useLeagues>['membershipStatus']
    membershipValidated: boolean
    membershipError: Error | null
    online: boolean
    refresh: () => Promise<void>
}

const LeagueContext = createContext<LeagueContextType | null>(null)

type LeagueSelection = {
    userId: string | null
    membershipId: string | null
}

const selectedLeagueCacheKey = (userId: string) => `pancake:selected-league:v1:${userId}`

function readSelectedMembershipId(userId: string | null): string | null {
    if (!userId) return null
    const value = readPersistentCache<unknown>(selectedLeagueCacheKey(userId))
    return typeof value === 'string' ? value : null
}

export function LeagueProvider({ children }: PropsWithChildren) {
    const { user } = useAuth()
    const { memberships, loading, error: membershipError, membershipStatus, membershipValidated, online, refresh } = useLeagues()
    const userId = user?.id ?? null
    const persistedMembershipId = useMemo(() => readSelectedMembershipId(userId), [userId])
    const [selection, setSelection] = useState<LeagueSelection>(() => ({
        userId,
        membershipId: persistedMembershipId,
    }))
    const currentId = selection.userId === userId ? selection.membershipId : persistedMembershipId

    // Derive current from memberships so it always reflects fresh data.
    // Memoize on [memberships, currentId] so the reference is stable across
    // unrelated parent re-renders — otherwise every consumer effect that depends
    // on `current` refires on each render.
    const current = useMemo(
        () => userId ? memberships.find((m) => m.id === currentId)
            ?? (currentId && !membershipValidated ? null : memberships[0] ?? null) : null,
        [memberships, currentId, userId, membershipValidated],
    )

    const currentLeague = useMemo(() => current?.leagues ?? null, [current])
    useLeagueChangeStream(currentLeague?.id, userId, membershipValidated && !membershipError)
    useMemberClaimsStream(current?.id, userId, membershipValidated && !membershipError)

    const isCommissioner = useMemo(() => {
        if (!current || !user) return false
        return current.role === 'commissioner' || current.role === 'co_commissioner'
    }, [current, user])

    const setCurrent = useCallback((m: LeagueMembership) => {
        if (!userId || !memberships.some((membership) => membership.id === m.id)) return
        setSelection({ userId, membershipId: m.id })
        writePersistentCache(selectedLeagueCacheKey(userId), m.id)
    }, [memberships, userId])

    useEffect(() => {
        setSelection((previous) => previous.userId === userId
            ? previous
            : { userId, membershipId: persistedMembershipId })
    }, [persistedMembershipId, userId])

    useEffect(() => {
        if (!userId || loading || membershipError || !membershipValidated) return
        const validatedId = memberships.some((membership) => membership.id === currentId)
            ? currentId
            : memberships[0]?.id ?? null
        setSelection((previous) => (
            previous.userId === userId && previous.membershipId === validatedId
                ? previous
                : { userId, membershipId: validatedId }
        ))
        if (validatedId) writePersistentCache(selectedLeagueCacheKey(userId), validatedId)
        else removePersistentCache(selectedLeagueCacheKey(userId))
    }, [currentId, loading, membershipError, memberships, userId, membershipValidated])

    // Memoize context value so consumers don't tear / re-render on every parent tick.
    const value = useMemo<LeagueContextType>(
        () => ({ memberships, current, currentLeague, isCommissioner, setCurrent, loading, refresh, membershipStatus, membershipValidated, membershipError, online }),
        [memberships, current, currentLeague, isCommissioner, setCurrent, loading, refresh, membershipStatus, membershipValidated, membershipError, online],
    )

    return <LeagueContext.Provider value={value}><PlayerEligibilityContext.Provider value={currentLeague?.taxi_slots ?? 0}>{children}</PlayerEligibilityContext.Provider></LeagueContext.Provider>
}

export function useLeagueContext() {
    const ctx = useContext(LeagueContext)
    if (!ctx) throw new Error('useLeagueContext must be used within LeagueProvider')
    return ctx
}
