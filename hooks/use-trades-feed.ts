import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getTradesForScreen, type Trade, type TradePageCursor, type TradeRosterPlan } from '@/lib/trades'
import { getErrorMessage } from '@/lib/shared/errors'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'

const TRADES_CACHE_PREFIX = 'pancake:trades:v2:'
const TRADES_PAGE_SIZE = 40
const tradesCacheKey = (memberId: string, leagueId: string) => `${TRADES_CACHE_PREFIX}${leagueId}:${memberId}`
type TradesResource = { key: string | null; trades: Trade[] }

export function useTradesFeed(memberId: string, leagueId: string, online = true, options: { autoLoad?: boolean } = {}) {
    const autoLoad = options.autoLoad ?? true
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
    const [settledKey, setSettledKey] = useState(cached ? resourceKey : null)
    const [loading, setLoading] = useState(!cached)
    const [validatedKey, setValidatedKey] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [hasMore, setHasMore] = useState((cached?.length ?? 0) >= TRADES_PAGE_SIZE)
    const [loadingMore, setLoadingMore] = useState(false)
    // A failed next page is not a failed load: the pages already shown stay valid.
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
    const loadSequence = useRef(0)
    const paginationRequest = useRef<symbol | null>(null)
    const nextCursor = useRef<TradePageCursor | null>(null)

    const refresh = useCallback(async () => {
        const requestId = ++loadSequence.current
        setValidatedKey(null)
        paginationRequest.current = null
        nextCursor.current = null
        setLoadingMore(false)
        setHasMore(false)
        // A refresh replaces the first page, so a failed next page is moot.
        setLoadMoreError(null)
        if (!memberId || !leagueId) {
            setResource({ key: null, trades: [] })
            setError(null)
            setLoading(false)
            setHasMore(false)
            return false
        }
        setError(null)
        setLoading(true)
        try {
            const result = await getTradesForScreen(memberId, leagueId, TRADES_PAGE_SIZE)
            if (loadSequence.current !== requestId) return false
            nextCursor.current = result.nextCursor
            setResource({ key: resourceKey, trades: result.trades })
            setSettledKey(resourceKey)
            setValidatedKey(resourceKey)
            setHasMore(result.hasMore)
            writePersistentCache(tradesCacheKey(memberId, leagueId), result.trades)
            return true
        } catch (cause) {
            if (loadSequence.current !== requestId) return false
            console.error(cause)
            setError(getErrorMessage(cause) ?? 'Unknown error')
            return false
        } finally {
            if (loadSequence.current === requestId) setLoading(false)
        }
    }, [leagueId, memberId, resourceKey])

    useEffect(() => {
        loadSequence.current += 1
        paginationRequest.current = null
        nextCursor.current = null
        setResource({ key: resourceKey, trades: cached ?? [] })
        setSettledKey(cached ? resourceKey : null)
        setValidatedKey(null)
        setError(null)
        setLoadMoreError(null)
        setLoading(!cached)
        setHasMore((cached?.length ?? 0) >= TRADES_PAGE_SIZE)
        setLoadingMore(false)
    }, [cached, resourceKey])

    useEffect(() => {
        loadSequence.current += 1
        setValidatedKey(null)
        if (!online) setLoading(false)
    }, [online])

    useEffect(() => {
        if (autoLoad) void refresh()
        return () => { loadSequence.current += 1 }
    }, [autoLoad, refresh])

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
            const known = new Set(trades.map((trade) => trade.id))
            const added = result.trades.filter((trade) => !known.has(trade.id))
            setResource((current) => {
                if (current.key !== resourceKey) return current
                const next = [...current.trades, ...added]
                writePersistentCache(tradesCacheKey(memberId, leagueId), next)
                return { key: resourceKey, trades: next }
            })
            nextCursor.current = result.nextCursor
            setHasMore(result.hasMore)
            if (loadSequence.current === requestId) setLoadMoreError(null)
        } catch (cause) {
            if (loadSequence.current === requestId) {
                setLoadMoreError(getErrorMessage(cause) ?? 'Could not load more trades.')
            }
        } finally {
            if (paginationRequest.current === paginationToken) {
                paginationRequest.current = null
                if (loadSequence.current === requestId) setLoadingMore(false)
            }
        }
    }, [hasMore, leagueId, memberId, resourceKey, trades])

    const updateRosterPlan = useCallback((tradeId: string, plan: TradeRosterPlan) => {
        setResource((current) => {
            if (current.key !== resourceKey) return current
            const next = current.trades.map((trade) => trade.id !== tradeId ? trade : {
                ...trade,
                routedItems: trade.routedItems.map((item) => item.kind === 'player' && item.toMemberId === memberId ? {
                    ...item,
                    toTaxi: item.fromTaxi === true || plan.taxiPlayerIds.includes(item.playerId),
                    toIR: plan.irPlayerIds.includes(item.playerId),
                } : item),
                participants: trade.participants.map((participant) => participant.memberId === memberId ? {
                    ...participant, dropPlayerIds: plan.dropPlayerIds, rosterMoves: plan.rosterMoves ?? [],
                } : participant),
            })
            writePersistentCache(tradesCacheKey(memberId, leagueId), next)
            return { key: resourceKey, trades: next }
        })
    }, [leagueId, memberId, resourceKey])

    const ownsResource = resource.key === resourceKey
    return {
        trades,
        hasData: Boolean(resourceKey && (settledKey === resourceKey || cached)),
        loading: ownsResource ? loading : !cached,
        loadingMore: ownsResource && loadingMore,
        hasMore: ownsResource ? hasMore : (cached?.length ?? 0) >= TRADES_PAGE_SIZE,
        error: ownsResource ? error : null,
        isSnapshot: resourceKey !== null && validatedKey !== resourceKey,
        loadMoreError: ownsResource ? loadMoreError : null,
        refresh,
        loadMore,
        updateRosterPlan,
    }
}
