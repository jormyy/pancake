import { useEffect, useState } from 'react'
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

    useEffect(() => {
        if (!memberId || !leagueId) {
            setCount(0)
            return
        }
        let cancelled = false
        const fetchCount = async () => {
            try {
                const pending = await getPendingIncomingTradeCount(memberId, leagueId)
                if (!cancelled) setCount(pending)
            } catch (error) {
                if (!cancelled) console.error(error)
            }
        }
        fetchCount()
        const channel = subscribeToTableChanges(
            `pending-trade-count:${leagueId}:${memberId}`,
            [
                { table: 'trades', filter: `league_id=eq.${leagueId}` },
                { table: 'trade_participants', filter: `league_id=eq.${leagueId}` },
            ],
            fetchCount,
        )
        if (typeof window !== 'undefined') {
            window.addEventListener('focus', fetchCount)
            return () => {
                cancelled = true
                window.removeEventListener('focus', fetchCount)
                unsubscribeFromTableChanges(channel)
            }
        }
        return () => {
            cancelled = true
            unsubscribeFromTableChanges(channel)
        }
    }, [memberId, leagueId, pathname])

    return count
}
