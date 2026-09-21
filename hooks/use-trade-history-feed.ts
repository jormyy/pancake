import { useCallback, useEffect, useRef, useState } from 'react'
import { getTradeHistoryForScreen, type Trade, type TradePageCursor } from '@/lib/trades'
import { getErrorMessage } from '@/lib/shared/errors'

const PAGE_SIZE = 40
type HistoryResource = { key: string | null; trades: Trade[] }

export function useTradeHistoryFeed(memberId: string, leagueId: string, enabled: boolean) {
    const resourceKey = memberId && leagueId ? `${leagueId}:${memberId}` : null
    const [resource, setResource] = useState<HistoryResource>({ key: resourceKey, trades: [] })
    const trades = resource.key === resourceKey ? resource.trades : []
    const [loading, setLoading] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)
    const [hasMore, setHasMore] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const sequence = useRef(0)
    const nextCursor = useRef<TradePageCursor | null>(null)
    const paginationRequest = useRef<symbol | null>(null)
    const activeKey = useRef(resourceKey)
    activeKey.current = resourceKey

    const refresh = useCallback(async () => {
        const requestId = ++sequence.current
        const requestKey = resourceKey
        paginationRequest.current = null
        nextCursor.current = null
        setLoadingMore(false)
        setHasMore(false)
        if (!memberId || !leagueId) {
            setResource({ key: null, trades: [] })
            setError(null)
            setLoading(false)
            return
        }
        setLoading(true)
        setError(null)
        try {
            const result = await getTradeHistoryForScreen(memberId, leagueId, PAGE_SIZE)
            if (sequence.current !== requestId || activeKey.current !== requestKey) return
            setResource({ key: requestKey, trades: result.trades })
            nextCursor.current = result.nextCursor
            setHasMore(result.hasMore)
        } catch (cause) {
            if (sequence.current !== requestId || activeKey.current !== requestKey) return
            setError(getErrorMessage(cause) ?? 'Could not load trade history.')
        } finally {
            if (sequence.current === requestId && activeKey.current === requestKey) setLoading(false)
        }
    }, [leagueId, memberId, resourceKey])

    useEffect(() => {
        sequence.current += 1
        paginationRequest.current = null
        nextCursor.current = null
        setResource({ key: resourceKey, trades: [] })
        setError(null)
        setLoading(false)
        setLoadingMore(false)
        setHasMore(false)
    }, [resourceKey])

    useEffect(() => {
        if (!enabled) return
        void refresh()
        return () => { sequence.current += 1 }
    }, [enabled, refresh])

    const loadMore = useCallback(async () => {
        if (!memberId || !leagueId || resource.key !== resourceKey || paginationRequest.current ||
            !hasMore || !nextCursor.current) return
        const requestId = sequence.current
        const token = Symbol('history-page')
        const cursor = nextCursor.current
        paginationRequest.current = token
        setLoadingMore(true)
        try {
            const result = await getTradeHistoryForScreen(memberId, leagueId, PAGE_SIZE, cursor)
            if (sequence.current !== requestId || activeKey.current !== resourceKey) return
            setResource((current) => {
                if (current.key !== resourceKey) return current
                const known = new Set(current.trades.map((trade) => trade.id))
                return {
                    key: resourceKey,
                    trades: [...current.trades, ...result.trades.filter((trade) => !known.has(trade.id))],
                }
            })
            nextCursor.current = result.nextCursor
            setHasMore(result.hasMore)
        } catch (cause) {
            if (sequence.current === requestId && activeKey.current === resourceKey) {
                setError(getErrorMessage(cause) ?? 'Could not load more trade history.')
            }
        } finally {
            if (paginationRequest.current === token) {
                paginationRequest.current = null
                if (sequence.current === requestId && activeKey.current === resourceKey) setLoadingMore(false)
            }
        }
    }, [hasMore, leagueId, memberId, resourceKey, resource.key])

    const ownsResource = resource.key === resourceKey
    return {
        trades,
        loading: ownsResource && loading,
        loadingMore: ownsResource && loadingMore,
        hasMore: ownsResource && hasMore,
        error: ownsResource ? error : null,
        refresh,
        loadMore,
    }
}
