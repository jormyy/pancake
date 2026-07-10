import { fetchUserLeagues } from '@/lib/league'
import { useAuth } from '@/hooks/use-auth'
import type { LeagueMembership } from '@/types/app'
import { readPersistentCache, removePersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { reportRealtimeCleanup, subscribeToTableChanges, unsubscribeFromTableChanges } from '@/lib/realtime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type { LeagueMembership }

const cacheKeyForUser = (userId: string) => `pancake:league-memberships:v1:${userId}`
type LeagueResource = {
    userId: string | null
    memberships: LeagueMembership[]
    loading: boolean
    error: Error | null
}

export function useLeagues() {
    const { user } = useAuth()
    const userId = user?.id ?? null
    const cachedMemberships = useMemo(
        () => userId ? readPersistentCache<LeagueMembership[]>(cacheKeyForUser(userId)) ?? [] : [],
        [userId],
    )
    const [resource, setResource] = useState<LeagueResource>({
        userId,
        memberships: cachedMemberships,
        loading: Boolean(userId && cachedMemberships.length === 0),
        error: null,
    })
    const requestIdRef = useRef(0)
    const activeUserIdRef = useRef(userId)
    activeUserIdRef.current = userId
    const ownsUser = resource.userId === userId
    const memberships = ownsUser ? resource.memberships : cachedMemberships
    const loading = ownsUser ? resource.loading : Boolean(userId && cachedMemberships.length === 0)
    const error = ownsUser ? resource.error : null
    const membershipsRef = useRef({ userId, memberships })
    membershipsRef.current = { userId, memberships }

    const load = useCallback(async (options: { force?: boolean } = {}) => {
        const requestedUserId = user?.id ?? null
        const requestId = ++requestIdRef.current

        if (!requestedUserId) {
            setResource({ userId: null, memberships: [], loading: false, error: null })
            return
        }

        const cacheKey = cacheKeyForUser(requestedUserId)
        const cached = readPersistentCache<LeagueMembership[]>(cacheKey) ?? []
        const hasVisibleRows = (
            membershipsRef.current.userId === requestedUserId && membershipsRef.current.memberships.length > 0
        ) || cached.length > 0

        if (!options.force) {
            setResource({ userId: requestedUserId, memberships: cached, loading: !hasVisibleRows, error: null })
            membershipsRef.current = { userId: requestedUserId, memberships: cached }
        } else {
            setResource((current) => current.userId === requestedUserId
                ? { ...current, loading: !hasVisibleRows, error: null }
                : { userId: requestedUserId, memberships: cached, loading: !hasVisibleRows, error: null })
        }

        try {
            const rows = await fetchUserLeagues(requestedUserId) as LeagueMembership[]
            if (requestIdRef.current !== requestId || activeUserIdRef.current !== requestedUserId) return
            setResource({ userId: requestedUserId, memberships: rows, loading: false, error: null })
            membershipsRef.current = { userId: requestedUserId, memberships: rows }
            if (rows.length > 0) writePersistentCache(cacheKey, rows)
            else removePersistentCache(cacheKey)
        } catch (e) {
            if (requestIdRef.current !== requestId || activeUserIdRef.current !== requestedUserId) return
            const nextError = e instanceof Error ? e : new Error(String(e))
            setResource((current) => current.userId === requestedUserId
                ? { ...current, loading: false, error: nextError }
                : current)
            console.error(nextError)
        }
    }, [user?.id])

    useEffect(() => {
        void load()
    }, [load])

    const refresh = useCallback(() => load({ force: true }), [load])

    const leagueRealtimeKey = useMemo(
        () => memberships.map((membership) => membership.leagues.id).sort().join(':'),
        [memberships],
    )

    useEffect(() => {
        const userId = user?.id
        if (!userId) return

        const leagueIds = leagueRealtimeKey ? leagueRealtimeKey.split(':') : []
        const channel = subscribeToTableChanges(
            `league-context:${userId}:${leagueRealtimeKey || 'none'}`,
            { mode: 'fallback', watches: [
                { table: 'league_members', filter: `user_id=eq.${userId}` },
                ...leagueIds.flatMap((leagueId) => [
                    { table: 'leagues', filter: `id=eq.${leagueId}` },
                    { table: 'league_members', filter: `league_id=eq.${leagueId}` },
                ]),
            ], onChange: () => { void refresh() } },
        )

        return () => reportRealtimeCleanup('league context', unsubscribeFromTableChanges(channel))
    }, [leagueRealtimeKey, refresh, user?.id])

    return { memberships, loading, error, refresh }
}
