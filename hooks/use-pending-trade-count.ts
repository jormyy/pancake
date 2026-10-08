import { useCallback, useEffect, useRef, useState } from 'react'
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
    // The count remembers whose it is, so a league switch never shows the
    // previous league's number while the new one loads.
    const [state, setState] = useState<{ key: string; count: number } | null>(null)
    const requestRef = useRef(0)
    const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const fetchCount = useCallback(async (attempt = 0) => {
        const requestId = ++requestRef.current
        if (retryRef.current) clearTimeout(retryRef.current)
        retryRef.current = null
        if (!memberId || !leagueId) return
        try {
            const pending = await getPendingIncomingTradeCount(memberId, leagueId)
            if (requestRef.current === requestId) setState({ key: `${leagueId}:${memberId}`, count: pending })
        } catch (error) {
            if (requestRef.current !== requestId) return
            console.error(error)
            // A dropped request would hide the badge until the next page change.
            if (attempt < MAX_RETRIES) {
                retryRef.current = setTimeout(() => { void fetchCount(attempt + 1) }, RETRY_DELAY_MS * (attempt + 1))
            }
        }
    }, [leagueId, memberId])

    useEffect(() => {
        if (!memberId || !leagueId) return
        const refresh = () => { void fetchCount() }
        const channel = subscribeToTableChanges(
            `pending-trade-count:${leagueId}:${memberId}`,
            { mode: 'fallback', watches: [
                { table: 'trades', filter: `league_id=eq.${leagueId}` },
                { table: 'trade_participants', filter: `league_id=eq.${leagueId}` },
            ], onChange: refresh },
        )
        if (typeof window !== 'undefined') window.addEventListener('focus', refresh)
        return () => {
            requestRef.current += 1
            if (retryRef.current) clearTimeout(retryRef.current)
            if (typeof window !== 'undefined') window.removeEventListener('focus', refresh)
            reportRealtimeCleanup('pending trade count', unsubscribeFromTableChanges(channel))
        }
    }, [fetchCount, memberId, leagueId])

    useEffect(() => {
        void fetchCount()
    }, [fetchCount, pathname])

    return state && state.key === key ? state.count : 0
}

const MAX_RETRIES = 2
const RETRY_DELAY_MS = 2000
