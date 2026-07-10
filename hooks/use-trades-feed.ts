import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getTradesForScreen, type Trade, type TradePageCursor } from '@/lib/trades'
import { getErrorMessage } from '@/lib/alert'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'

const TRADES_CACHE_PREFIX = 'pancake:trades:v2:'
const TRADES_PAGE_SIZE = 40
const tradesCacheKey = (memberId: string, leagueId: string) => `${TRADES_CACHE_PREFIX}${leagueId}:${memberId}`
type TradesResource = { key: string | null; trades: Trade[] }

export function useTradesFeed(memberId: string, leagueId: string) {
    const resourceKey = memberId && leagueId ? tradesCacheKey(memberId, leagueId) : null
    const cached = useMemo(
        () => memberId && leagueId ? readPersistentCache<Trade[]>(tradesCacheKey(memberId, leagueId)) : null,
        [memberId, leagueId],
    )
    const [resource, setResource] = useState<TradesResource>({ key: resourceKey, trades: cached ?? [] })
    const trades = useMemo(
        () => resource.key === resourceKey ? resource.trades : cached ?? [],
        [cached, resource, resourceKey],
    )
    const [loading, setLoading] = useState(!cached)
    const [error, setError] = useState<string | null>(null)
    const [hasMore, setHasMore] = useState((cached?.length ?? 0) >= TRADES_PAGE_SIZE)
    const [loadingMore, setLoadingMore] = useState(false)
    const loadSequence = useRef(0)
    const paginationRequest = useRef<symbol | null>(null)
    const nextCursor = useRef<TradePageCursor | null>(null)

    const refresh = useCallback(async () => {
        const requestId = ++loadSequence.current
        paginationRequest.current = null
        nextCursor.current = null
        setLoadingMore(false)
        setHasMore(false)
        if (!memberId || !leagueId) {
            setResource({ key: null, trades: [] })
            setError(null)
            setLoading(false)
            setHasMore(false)
            return
        }
        setError(null)
        try {
            const result = await getTradesForScreen(memberId, leagueId, TRADES_PAGE_SIZE)
            if (loadSequence.current !== requestId) return
            nextCursor.current = result.nextCursor
            setResource({ key: resourceKey, trades: result.trades })
            setHasMore(result.trades.length === TRADES_PAGE_SIZE && result.nextCursor != null)
            writePersistentCache(tradesCacheKey(memberId, leagueId), result.trades)
        } catch (cause) {
            if (loadSequence.current !== requestId) return
            console.error(cause)
            setError(getErrorMessage(cause) ?? 'Unknown error')
        } finally {
            if (loadSequence.current === requestId) setLoading(false)
        }
    }, [leagueId, memberId, resourceKey])

    useEffect(() => {
        loadSequence.current += 1
        paginationRequest.current = null
        nextCursor.current = null
        setResource({ key: resourceKey, trades: cached ?? [] })
        setError(null)
        setLoading(!cached)
        setHasMore((cached?.length ?? 0) >= TRADES_PAGE_SIZE)
        setLoadingMore(false)
    }, [cached, resourceKey])

    useEffect(() => {
        void refresh()
        return () => { loadSequence.current += 1 }
    }, [refresh])

    const loadMore = useCallback(async () => {
        if (!memberId || !leagueId || paginationRequest.current || !hasMore) return
        const requestId = loadSequence.current
        const paginationToken = Symbol('trade-page')
        paginationRequest.current = paginationToken
        setLoadingMore(true)
        try {
            const cursor = nextCursor.current
            if (!cursor) return
            const result = await getTradesForScreen(
                memberId,
                leagueId,
                TRADES_PAGE_SIZE,
                cursor,
            )
            if (loadSequence.current !== requestId) return
            setResource((current) => {
                if (current.key !== resourceKey) return current
                const known = new Set(current.trades.map((trade) => trade.id))
                const next = [...current.trades, ...result.trades.filter((trade) => !known.has(trade.id))]
                writePersistentCache(tradesCacheKey(memberId, leagueId), next)
                return { key: resourceKey, trades: next }
            })
            nextCursor.current = result.nextCursor
            setHasMore(result.trades.length === TRADES_PAGE_SIZE && result.nextCursor != null)
        } catch (cause) {
            if (loadSequence.current === requestId) {
                setError(getErrorMessage(cause) ?? 'Could not load more trades.')
            }
        } finally {
            if (paginationRequest.current === paginationToken) {
                paginationRequest.current = null
                if (loadSequence.current === requestId) setLoadingMore(false)
            }
        }
    }, [hasMore, leagueId, memberId, resourceKey])

    const ownsResource = resource.key === resourceKey
    return {
        trades,
        loading: ownsResource ? loading : !cached,
        loadingMore: ownsResource && loadingMore,
        hasMore: ownsResource ? hasMore : (cached?.length ?? 0) >= TRADES_PAGE_SIZE,
        error: ownsResource ? error : null,
        refresh,
        loadMore,
    }
}
