import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getTradesForScreen, type Trade } from '@/lib/trades'
import { getErrorMessage } from '@/lib/alert'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'

const TRADES_CACHE_PREFIX = 'pancake:trades:v2:'
const tradesCacheKey = (memberId: string, leagueId: string) => `${TRADES_CACHE_PREFIX}${leagueId}:${memberId}`

export function useTradesFeed(memberId: string, leagueId: string) {
    const cached = useMemo(
        () => memberId && leagueId ? readPersistentCache<Trade[]>(tradesCacheKey(memberId, leagueId)) : null,
        [memberId, leagueId],
    )
    const [trades, setTrades] = useState<Trade[]>(cached ?? [])
    const [loading, setLoading] = useState(!cached)
    const [error, setError] = useState<string | null>(null)
    const loadSequence = useRef(0)

    const refresh = useCallback(async () => {
        const requestId = ++loadSequence.current
        if (!memberId || !leagueId) {
            setTrades([])
            setError(null)
            setLoading(false)
            return
        }
        setError(null)
        try {
            const result = await getTradesForScreen(memberId, leagueId)
            if (loadSequence.current !== requestId) return
            setTrades(result)
            writePersistentCache(tradesCacheKey(memberId, leagueId), result)
        } catch (cause) {
            if (loadSequence.current !== requestId) return
            console.error(cause)
            setError(getErrorMessage(cause) ?? 'Unknown error')
        } finally {
            if (loadSequence.current === requestId) setLoading(false)
        }
    }, [memberId, leagueId])

    useEffect(() => {
        loadSequence.current += 1
        setTrades(cached ?? [])
        setError(null)
        setLoading(!cached)
    }, [cached, leagueId, memberId])

    useEffect(() => {
        void refresh()
        return () => { loadSequence.current += 1 }
    }, [refresh])

    return { trades, loading, error, refresh }
}
