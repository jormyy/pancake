import { fetchUserLeagues } from '@/lib/league'
import { useAuth } from '@/hooks/use-auth'
import type { LeagueMembership } from '@/types/app'
import { readPersistentCache, removePersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { useCallback, useEffect, useRef, useState } from 'react'

export type { LeagueMembership }

const cacheKeyForUser = (userId: string) => `pancake:league-memberships:v1:${userId}`

export function useLeagues() {
    const { user } = useAuth()
    const [memberships, setMemberships] = useState<LeagueMembership[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<Error | null>(null)
    const requestIdRef = useRef(0)
    const membershipsRef = useRef<LeagueMembership[]>(memberships)

    useEffect(() => {
        membershipsRef.current = memberships
    }, [memberships])

    const load = useCallback(async (options: { force?: boolean } = {}) => {
        const userId = user?.id
        const requestId = ++requestIdRef.current

        if (!userId) {
            setMemberships([])
            setLoading(false)
            setError(null)
            return
        }

        const cacheKey = cacheKeyForUser(userId)
        const cached = readPersistentCache<LeagueMembership[]>(cacheKey) ?? []
        const hasVisibleRows = membershipsRef.current.length > 0 || cached.length > 0

        if (!options.force) {
            setMemberships(cached)
            membershipsRef.current = cached
        }

        setLoading(!hasVisibleRows)
        setError(null)

        try {
            const rows = await fetchUserLeagues(userId) as LeagueMembership[]
            if (requestIdRef.current !== requestId) return
            setMemberships(rows)
            membershipsRef.current = rows
            if (rows.length > 0) writePersistentCache(cacheKey, rows)
            else removePersistentCache(cacheKey)
        } catch (e) {
            if (requestIdRef.current !== requestId) return
            const nextError = e instanceof Error ? e : new Error(String(e))
            setError(nextError)
            console.error(nextError)
        } finally {
            if (requestIdRef.current === requestId) setLoading(false)
        }
    }, [user?.id])

    useEffect(() => {
        void load()
    }, [load])

    const refresh = useCallback(() => {
        void load({ force: true })
    }, [load])

    return { memberships, loading, error, refresh }
}
