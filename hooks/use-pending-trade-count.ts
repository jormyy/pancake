import { useSyncExternalStore } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { latestScreenContext, subscribeScreenContext } from '@/lib/cache/screen-cache'

export function usePendingTradeCount(): number {
    const { currentLeague } = useLeagueContext()
    const { user } = useAuth()
    return useSyncExternalStore(subscribeScreenContext, () => user && currentLeague ? latestScreenContext(user.id, currentLeague.id)?.pendingIncomingCount ?? 0 : 0, () => 0)
}
