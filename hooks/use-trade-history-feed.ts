import { useCallback, useEffect, useRef, useState } from 'react'
import { getTradeHistoryForScreen, type Trade, type TradePageCursor } from '@/lib/trades'
import { getErrorMessage } from '@/lib/alert'

const PAGE_SIZE = 40

export function useTradeHistoryFeed(memberId: string, leagueId: string, enabled: boolean) {
    const [trades, setTrades] = useState<Trade[]>([])
    const [loading, setLoading] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)
    const [hasMore, setHasMore] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const sequence = useRef(0)
    const nextCursor = useRef<TradePageCursor | null>(null)
    const paginationRequest = useRef<symbol | null>(null)

    const refresh = useCallback(async () => {
        const requestId = ++sequence.current
        paginationRequest.current = null
        nextCursor.current = null
        setLoadingMore(false)
        setHasMore(false)
        if (!memberId || !leagueId) {
            setTrades([])
            setError(null)
            setLoading(false)
            return
        }
        setLoading(true)
        setError(null)
        try {
            const result = await getTradeHistoryForScreen(memberId, leagueId, PAGE_SIZE)
            if (sequence.current !== requestId) return
            setTrades(result.trades)
            nextCursor.current = result.nextCursor
            setHasMore(result.nextCursor != null)
        } catch (cause) {
            if (sequence.current !== requestId) return
            setError(getErrorMessage(cause) ?? 'Could not load trade history.')
        } finally {
            if (sequence.current === requestId) setLoading(false)
        }
    }, [leagueId, memberId])

    useEffect(() => {
        sequence.current += 1
        paginationRequest.current = null
        nextCursor.current = null
        setTrades([])
        setError(null)
        setLoading(false)
        setLoadingMore(false)
        setHasMore(false)
    }, [leagueId, memberId])

    useEffect(() => {
        if (!enabled) return
        void refresh()
        return () => { sequence.current += 1 }
    }, [enabled, refresh])

    const loadMore = useCallback(async () => {
        if (!memberId || !leagueId || paginationRequest.current || !hasMore || !nextCursor.current) return
        const requestId = sequence.current
        const token = Symbol('history-page')
        const cursor = nextCursor.current
        paginationRequest.current = token
        setLoadingMore(true)
        try {
            const result = await getTradeHistoryForScreen(memberId, leagueId, PAGE_SIZE, cursor)
            if (sequence.current !== requestId) return
            setTrades((current) => {
                const known = new Set(current.map((trade) => trade.id))
                return [...current, ...result.trades.filter((trade) => !known.has(trade.id))]
            })
            nextCursor.current = result.nextCursor
            setHasMore(result.nextCursor != null)
        } catch (cause) {
            if (sequence.current === requestId) setError(getErrorMessage(cause) ?? 'Could not load more trade history.')
        } finally {
            if (paginationRequest.current === token) {
                paginationRequest.current = null
                if (sequence.current === requestId) setLoadingMore(false)
            }
        }
    }, [hasMore, leagueId, memberId])

    return { trades, loading, loadingMore, hasMore, error, refresh, loadMore }
}
