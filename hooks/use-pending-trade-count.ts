import { useEffect, useState } from 'react'
import { usePathname } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { supabase } from '@/lib/supabase'

/**
 * Count of pending incoming trade offers for the current member — powers the
 * nav-level badge on the Trades item. Head-only count query (no rows), keyed
 * on the same fields lib/trades.ts filters by. Refetches on route change (so
 * accepting/rejecting on /trades clears the badge when you navigate away) and
 * on window focus.
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
            const { count: pending, error } = await supabase
                .from('trades')
                .select('id', { count: 'exact', head: true })
                .eq('league_id', leagueId)
                .eq('recipient_member_id', memberId)
                .eq('status', 'pending')
            if (!cancelled && !error) setCount(pending ?? 0)
        }
        fetchCount()
        if (typeof window !== 'undefined') {
            window.addEventListener('focus', fetchCount)
            return () => {
                cancelled = true
                window.removeEventListener('focus', fetchCount)
            }
        }
        return () => {
            cancelled = true
        }
    }, [memberId, leagueId, pathname])

    return count
}
