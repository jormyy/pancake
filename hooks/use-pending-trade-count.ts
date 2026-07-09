import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { subscribeToTableChanges, unsubscribeFromTableChanges } from '@/lib/realtime'
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
    const [count, setCount] = useState(0)
    const memberId = current?.id
    const leagueId = currentLeague?.id
    const requestRef = useRef(0)

    const fetchCount = useCallback(async () => {
        const requestId = ++requestRef.current
        if (!memberId || !leagueId) {
            setCount(0)
            return
        }
        try {
            const pending = await getPendingIncomingTradeCount(memberId, leagueId)
            if (requestRef.current === requestId) setCount(pending)
        } catch (error) {
            if (requestRef.current === requestId) console.error(error)
        }
    }, [leagueId, memberId])

    useEffect(() => {
        if (!memberId || !leagueId) {
            setCount(0)
            return
        }
        fetchCount()
        const channel = subscribeToTableChanges(
            `pending-trade-count:${leagueId}:${memberId}`,
            { mode: 'fallback', watches: [
                { table: 'trades', filter: `league_id=eq.${leagueId}` },
                { table: 'trade_participants', filter: `league_id=eq.${leagueId}` },
            ], onChange: fetchCount },
        )
        if (typeof window !== 'undefined') {
            window.addEventListener('focus', fetchCount)
            return () => {
                requestRef.current += 1
                window.removeEventListener('focus', fetchCount)
                unsubscribeFromTableChanges(channel)
            }
        }
        return () => {
            requestRef.current += 1
            unsubscribeFromTableChanges(channel)
        }
    }, [fetchCount, memberId, leagueId])

    useEffect(() => {
        void fetchCount()
    }, [fetchCount, pathname])

    return count
}
