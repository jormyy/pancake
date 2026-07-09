import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getTradesForScreen, tradePageCursor, type Trade } from '@/lib/trades'
import { getErrorMessage } from '@/lib/alert'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'

const TRADES_CACHE_PREFIX = 'pancake:trades:v2:'
const TRADES_PAGE_SIZE = 40
const tradesCacheKey = (memberId: string, leagueId: string) => `${TRADES_CACHE_PREFIX}${leagueId}:${memberId}`

export function useTradesFeed(memberId: string, leagueId: string) {
    const cached = useMemo(
        () => memberId && leagueId ? readPersistentCache<Trade[]>(tradesCacheKey(memberId, leagueId)) : null,
        [memberId, leagueId],
    )
    const [trades, setTrades] = useState<Trade[]>(cached ?? [])
    const [loading, setLoading] = useState(!cached)
    const [error, setError] = useState<string | null>(null)
    const [hasMore, setHasMore] = useState((cached?.length ?? 0) >= TRADES_PAGE_SIZE)
    const [loadingMore, setLoadingMore] = useState(false)
    const loadSequence = useRef(0)

    const refresh = useCallback(async () => {
        const requestId = ++loadSequence.current
        if (!memberId || !leagueId) {
            setTrades([])
            setError(null)
            setLoading(false)
            setHasMore(false)
            return
        }
        setError(null)
        try {
            const result = await getTradesForScreen(memberId, leagueId, TRADES_PAGE_SIZE)
            if (loadSequence.current !== requestId) return
            setTrades(result)
            setHasMore(result.length === TRADES_PAGE_SIZE)
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
        setHasMore((cached?.length ?? 0) >= TRADES_PAGE_SIZE)
        setLoadingMore(false)
    }, [cached, leagueId, memberId])

    useEffect(() => {
        void refresh()
        return () => { loadSequence.current += 1 }
    }, [refresh])

    const loadMore = useCallback(async () => {
        if (!memberId || !leagueId || loadingMore || !hasMore) return
        const requestId = loadSequence.current
        setLoadingMore(true)
        try {
            const lastTrade = trades.at(-1)
            if (!lastTrade) return
            const result = await getTradesForScreen(
                memberId,
                leagueId,
                TRADES_PAGE_SIZE,
                tradePageCursor(lastTrade, memberId),
            )
            if (loadSequence.current !== requestId) return
            setTrades((current) => {
                const known = new Set(current.map((trade) => trade.id))
                const next = [...current, ...result.filter((trade) => !known.has(trade.id))]
                writePersistentCache(tradesCacheKey(memberId, leagueId), next)
                return next
            })
            setHasMore(result.length === TRADES_PAGE_SIZE)
        } catch (cause) {
            if (loadSequence.current === requestId) {
                setError(getErrorMessage(cause) ?? 'Could not load more trades.')
            }
        } finally {
            if (loadSequence.current === requestId) setLoadingMore(false)
        }
    }, [hasMore, leagueId, loadingMore, memberId, trades])

    return { trades, loading, loadingMore, hasMore, error, refresh, loadMore }
}
