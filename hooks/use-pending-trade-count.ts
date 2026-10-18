import { useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { reportRealtimeCleanup, subscribeToTableChanges, unsubscribeFromTableChanges } from '@/lib/realtime'
import { getPendingIncomingTradeCount } from '@/lib/trades'

/**
 * Count of pending incoming trade offers for the current member — powers the
 * nav-level badge on the Trades item. The lib query uses the same
 * participant-aware semantics as the Offers tab. Refetches on route change
 * (so accepting/rejecting on /trades clears the badge when you navigate away)
 * and on window focus.
 */
export function usePendingTradeCount(): number {
    const { current, currentLeague } = useLeagueContext()
    const pathname = usePathname()
    const memberId = current?.id
    const leagueId = currentLeague?.id
    const key = memberId && leagueId ? `${leagueId}:${memberId}` : null
    const activeKeyRef = useRef(key)
    activeKeyRef.current = key
    // The count remembers whose it is, so a league switch never shows the
    // previous league's number while the new one loads.
    const [state, setState] = useState<{ key: string; count: number } | null>(null)
    const refreshQueue = useMemo(() => {
        let disposed = false
        let pending = false
        let revision = 0
        let inFlight: Promise<void> | null = null
        let timer: ReturnType<typeof setTimeout> | null = null
        let retryTimer: ReturnType<typeof setTimeout> | null = null
        let lastLoadedAt = 0
        const isCurrent = () => !disposed && activeKeyRef.current === key
        const canRefresh = () => (typeof navigator === 'undefined' || navigator.onLine !== false)
            && (typeof document === 'undefined' || document.visibilityState !== 'hidden')
        const clearRetry = () => {
            if (retryTimer) clearTimeout(retryTimer)
            retryTimer = null
        }
        const run = (attempt = 0): Promise<void> => {
            if (!isCurrent() || !memberId || !leagueId || !key) return Promise.resolve()
            pending = true
            if (!canRefresh()) return Promise.resolve()
            clearRetry()
            if (inFlight) {
                revision += 1
                return inFlight
            }
            if (timer) clearTimeout(timer)
            timer = null
            const task = (async () => {
                try {
                    let nextAttempt = attempt
                    do {
                        pending = false
                        const requestId = ++revision
                        try {
                            const count = await getPendingIncomingTradeCount(memberId, leagueId)
                            if (isCurrent() && requestId === revision) {
                                lastLoadedAt = Date.now()
                                setState((previous) => {
                                    if (!isCurrent() || requestId !== revision) return previous
                                    return previous?.key === key && previous.count === count ? previous : { key, count }
                                })
                            }
                        } catch (error) {
                            if (isCurrent() && requestId === revision) {
                                lastLoadedAt = 0
                                console.error(error)
                                // Keep the last count and retry a dropped authoritative read.
                                if (nextAttempt < MAX_RETRIES) {
                                    const retryAttempt = nextAttempt + 1
                                    retryTimer = setTimeout(() => {
                                        retryTimer = null
                                        void run(retryAttempt)
                                    }, RETRY_DELAY_MS * retryAttempt)
                                }
                            }
                        }
                        nextAttempt = 0
                    } while (pending && isCurrent() && canRefresh())
                } finally {
                    inFlight = null
                }
            })()
            inFlight = task
            return task
        }
        const trigger = () => {
            if (!isCurrent() || !key) return
            pending = true
            clearRetry()
            if (inFlight) {
                revision += 1
                return
            }
            if (!canRefresh() || timer) return
            // The first signal sets the deadline; later signals cannot extend it.
            timer = setTimeout(() => { timer = null; void run() }, REFRESH_WINDOW_MS)
        }
        return {
            run, trigger,
            ensure: () => {
                if (!isCurrent() || !canRefresh()) return Promise.resolve()
                if (inFlight) return inFlight
                return !pending && lastLoadedAt > 0 && Date.now() - lastLoadedAt < COUNT_STALE_MS ? Promise.resolve() : run()
            },
            activate: () => { disposed = false },
            cancel: () => {
                disposed = true
                pending = false
                revision += 1
                if (timer) clearTimeout(timer)
                timer = null
                clearRetry()
            },
        }
    }, [key, leagueId, memberId])

    useEffect(() => {
        refreshQueue.activate()
        if (!memberId || !leagueId) {
            setState(null)
            return refreshQueue.cancel
        }
        const refresh = () => { refreshQueue.trigger() }
        const ensure = () => { void refreshQueue.ensure() }
        const visible = () => { if (document.visibilityState !== 'hidden') ensure() }
        const channel = subscribeToTableChanges(
            `pending-trade-count:${leagueId}:${memberId}`,
            { mode: 'fallback', watches: [
                { table: 'trades', filter: `league_id=eq.${leagueId}` },
                { table: 'trade_participants', filter: `league_id=eq.${leagueId}` },
            ], onChange: refresh, onReconnect: refreshQueue.run },
        )
        if (typeof window !== 'undefined') {
            window.addEventListener('focus', ensure)
            window.addEventListener('online', refresh)
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visible)
        void refreshQueue.run()
        return () => {
            refreshQueue.cancel()
            if (typeof window !== 'undefined') {
                window.removeEventListener('focus', ensure)
                window.removeEventListener('online', refresh)
            }
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visible)
            reportRealtimeCleanup('pending trade count', unsubscribeFromTableChanges(channel))
        }
    }, [refreshQueue, memberId, leagueId])

    const lastPathnameRef = useRef(pathname)
    useEffect(() => {
        const changed = lastPathnameRef.current !== pathname
        lastPathnameRef.current = pathname
        if (changed) refreshQueue.trigger()
    }, [refreshQueue, pathname])

    return state && state.key === key ? state.count : 0
}

const MAX_RETRIES = 2
const RETRY_DELAY_MS = 2000
const REFRESH_WINDOW_MS = 250
const COUNT_STALE_MS = 300_000
