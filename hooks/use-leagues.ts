import { fetchUserLeagues } from '@/lib/league'
import { useAuth } from '@/hooks/use-auth'
import { useOnlineStatus } from '@/hooks/use-online-status'
import type { LeagueMembership } from '@/types/app'
import { readPersistentCache, removePersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { reportRealtimeCleanup, subscribeToTableChanges, unsubscribeFromTableChanges } from '@/lib/realtime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type { LeagueMembership }

const cacheKeyForUser = (userId: string) => `pancake:league-memberships:v1:${userId}`
const MEMBERSHIP_REFRESH_WINDOW_MS = 250
const MEMBERSHIP_STALE_MS = 300_000
const MEMBERSHIP_RETRY_DELAY_MS = 1000

function reuseMemberships(previous: LeagueMembership[], rows: LeagueMembership[]): LeagueMembership[] {
    const byId = new Map(previous.map((row) => [row.id, row]))
    const shared = rows.map((row) => {
        const old = byId.get(row.id)
        return old && JSON.stringify(old) === JSON.stringify(row) ? old : row
    })
    return shared.length === previous.length && shared.every((row, index) => row === previous[index])
        ? previous : shared
}
type LeagueResource = {
    userId: string | null
    memberships: LeagueMembership[]
    loading: boolean
    error: Error | null
    validated: boolean
}

export function useLeagues() {
    const { user } = useAuth()
    const userId = user?.id ?? null
    const online = useOnlineStatus()
    const onlineRef = useRef(online)
    onlineRef.current = online
    const wasOnlineRef = useRef(online)
    const cachedMemberships = useMemo(
        () => userId ? readPersistentCache<LeagueMembership[]>(cacheKeyForUser(userId)) ?? [] : [],
        [userId],
    )
    const [resource, setResource] = useState<LeagueResource>({
        userId,
        memberships: cachedMemberships,
        loading: Boolean(userId && cachedMemberships.length === 0),
        error: null,
        validated: false,
    })
    const requestIdRef = useRef(0)
    const validatedAtRef = useRef<{ userId: string; at: number } | null>(null)
    const activeUserIdRef = useRef(userId)
    activeUserIdRef.current = userId
    const ownsUser = resource.userId === userId
    const memberships = ownsUser ? resource.memberships : cachedMemberships
    const loading = ownsUser ? resource.loading : Boolean(userId && cachedMemberships.length === 0)
    const error = ownsUser ? resource.error : null
    const membershipValidated = ownsUser && resource.validated
    const membershipsRef = useRef({ userId, memberships })
    membershipsRef.current = { userId, memberships }

    const read = useCallback(async (options: { force?: boolean; retry?: boolean } = {}) => {
        const requestedUserId = user?.id ?? null
        const requestId = ++requestIdRef.current

        if (!requestedUserId) {
            validatedAtRef.current = null
            setResource({ userId: null, memberships: [], loading: false, error: null, validated: false })
            return
        }

        const cacheKey = cacheKeyForUser(requestedUserId)
        const cached = readPersistentCache<LeagueMembership[]>(cacheKey) ?? []
        const hasVisibleRows = (
            membershipsRef.current.userId === requestedUserId && membershipsRef.current.memberships.length > 0
        ) || cached.length > 0

        if (!options.force) {
            setResource({ userId: requestedUserId, memberships: cached, loading: !hasVisibleRows, error: null, validated: false })
            membershipsRef.current = { userId: requestedUserId, memberships: cached }
        } else {
            setResource((current) => current.userId === requestedUserId
                ? { ...current, loading: !hasVisibleRows, error: null }
                : { userId: requestedUserId, memberships: cached, loading: !hasVisibleRows, error: null, validated: false })
        }

        try {
            const fetchedRows = await fetchUserLeagues(requestedUserId) as LeagueMembership[]
            if (requestIdRef.current !== requestId || activeUserIdRef.current !== requestedUserId) return
            const previousRows = membershipsRef.current.userId === requestedUserId ? membershipsRef.current.memberships : []
            const rows = reuseMemberships(previousRows, fetchedRows)
            setResource((current) => current.userId === requestedUserId && current.memberships === rows
                && !current.loading && !current.error && current.validated
                ? current : { userId: requestedUserId, memberships: rows, loading: false, error: null, validated: true })
            membershipsRef.current = { userId: requestedUserId, memberships: rows }
            validatedAtRef.current = { userId: requestedUserId, at: Date.now() }
            if (rows.length > 0) writePersistentCache(cacheKey, rows)
            else removePersistentCache(cacheKey)
            return true
        } catch (e) {
            if (requestIdRef.current !== requestId || activeUserIdRef.current !== requestedUserId) return
            const nextError = e instanceof Error ? e : new Error(String(e))
            const retrying = !options.retry && !hasVisibleRows
            validatedAtRef.current = null
            setResource((current) => current.userId === requestedUserId
                ? { ...current, loading: retrying, error: retrying ? null : nextError }
                : current)
            console.error(nextError)
            return false
        }
    }, [user?.id])

    const refreshQueue = useMemo(() => {
        let disposed = false
        let pending = false
        let inFlight: Promise<void> | null = null
        let timer: ReturnType<typeof setTimeout> | null = null
        let retryTimer: ReturnType<typeof setTimeout> | null = null
        const isCurrent = () => !disposed && activeUserIdRef.current === userId
        const canRefresh = () => onlineRef.current
            && (typeof navigator === 'undefined' || navigator.onLine !== false)
            && (typeof document === 'undefined' || document.visibilityState !== 'hidden')
        const run = (options: { force?: boolean; retry?: boolean } = { force: true }): Promise<void> => {
            if (!isCurrent()) return Promise.resolve()
            if (retryTimer) clearTimeout(retryTimer)
            retryTimer = null
            pending = true
            if (userId && !canRefresh()) return Promise.resolve()
            if (inFlight) {
                requestIdRef.current += 1
                return inFlight
            }
            if (timer) clearTimeout(timer)
            timer = null
            const task = (async () => {
                let failed = false
                try {
                    let nextOptions = options
                    do {
                        pending = false
                        failed = await read(nextOptions) === false
                        nextOptions = { force: true, retry: options.retry }
                    } while (pending && isCurrent() && canRefresh())
                } finally {
                    inFlight = null
                    if (failed && !options.retry && !pending && isCurrent()) {
                        retryTimer = setTimeout(() => {
                            retryTimer = null
                            void run({ force: true, retry: true })
                        }, MEMBERSHIP_RETRY_DELAY_MS)
                    }
                }
            })()
            inFlight = task
            return task
        }
        const trigger = () => {
            if (!isCurrent()) return
            pending = true
            if (inFlight) {
                // A changed row makes the pending read stale, but needs only one follow-up.
                requestIdRef.current += 1
                return
            }
            if (!canRefresh() || timer) return
            // Start the window on the first event. Later events cannot postpone it.
            timer = setTimeout(() => {
                timer = null
                if (canRefresh()) void run()
            }, MEMBERSHIP_REFRESH_WINDOW_MS)
        }
        const ensure = () => {
            if (!isCurrent() || !canRefresh()) return Promise.resolve()
            if (inFlight) return inFlight
            const validated = validatedAtRef.current
            if (!pending && validated?.userId === userId && Date.now() - validated.at < MEMBERSHIP_STALE_MS) return Promise.resolve()
            return run()
        }
        return {
            run, trigger, ensure,
            activate: () => { disposed = false },
            cancel: () => {
                disposed = true
                pending = false
                if (timer) clearTimeout(timer)
                if (retryTimer) clearTimeout(retryTimer)
                requestIdRef.current += 1
            },
        }
    }, [read, userId])

    useEffect(() => {
        refreshQueue.activate()
        void refreshQueue.run({ force: false })
        return refreshQueue.cancel
    }, [refreshQueue])

    const refresh = useCallback(() => refreshQueue.run(), [refreshQueue])

    useEffect(() => {
        const wasOnline = wasOnlineRef.current
        wasOnlineRef.current = online
        if (!wasOnline && online && userId) refreshQueue.trigger()
    }, [online, refreshQueue, userId])

    useEffect(() => {
        if (!userId) return
        const catchUp = () => { void refreshQueue.ensure() }
        const reconnect = () => { refreshQueue.trigger() }
        if (typeof window !== 'undefined') {
            window.addEventListener('focus', catchUp)
            window.addEventListener('online', reconnect)
        }
        const onVisibility = () => {
            if (document.visibilityState !== 'hidden') catchUp()
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        return () => {
            if (typeof window !== 'undefined') {
                window.removeEventListener('focus', catchUp)
                window.removeEventListener('online', reconnect)
            }
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
    }, [refreshQueue, userId])

    const leagueRealtimeKey = useMemo(
        () => memberships.map((membership) => membership.leagues.id).sort().join(':'),
        [memberships],
    )

    useEffect(() => {
        const userId = user?.id
        if (!userId) return

        const leagueIds = leagueRealtimeKey ? leagueRealtimeKey.split(':') : []
        let disposed = false
        const channel = subscribeToTableChanges(
            `league-context:${userId}:${leagueRealtimeKey || 'none'}`,
            { mode: 'fallback', watches: [
                { table: 'league_members', filter: `user_id=eq.${userId}` },
                ...leagueIds.flatMap((leagueId) => [
                    { table: 'leagues', filter: `id=eq.${leagueId}` },
                    { table: 'league_members', filter: `league_id=eq.${leagueId}` },
                ]),
            ], onChange: () => { if (!disposed) refreshQueue.trigger() }, onReconnect: refreshQueue.run },
        )

        return () => {
            disposed = true
            reportRealtimeCleanup('league context', unsubscribeFromTableChanges(channel))
        }
    }, [leagueRealtimeKey, refreshQueue, user?.id])

    const membershipStatus = !userId ? 'signed-out'
        : memberships.length > 0 ? 'available'
            : loading ? 'loading'
                : error ? 'unavailable' : 'empty'

    return { memberships, loading, error, refresh, membershipStatus, membershipValidated, online }
}
