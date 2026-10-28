import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useScreenView } from '@/hooks/use-screen-view'
import { readScreenView } from '@/lib/cache/screen-cache'
import { screenScope } from '@/lib/cache/screen-scope'
import type { TradesView } from '@/lib/cache/view-types'
import type { Trade } from '@/lib/trades'
import { sessionOwner } from '@/lib/session-cache-registry'

export function useTradeViewPage(memberId: string, leagueId: string, tab: 'offers' | 'history', enabled: boolean, autoLoad = true) {
    const accountId = sessionOwner()
    const identity = JSON.stringify([accountId, memberId, leagueId, tab])
    const scope = accountId && memberId && leagueId ? screenScope('trades', leagueId, memberId, { tab, limit: 40 }, accountId) : null
    const view = useScreenView<TradesView>(scope, enabled, { autoLoad })
    const refreshView = view.refresh
    const [page, setPage] = useState<{ identity: string; base?: TradesView; trades: Trade[]; cursor: TradesView['nextCursor']; hasMore: boolean }>({ identity, trades: [], cursor: null, hasMore: false })
    const [loadingMore, setLoadingMore] = useState(false)
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
    const current = useRef(identity)
    current.current = identity
    const pending = useRef(false)
    const selected = useMemo(() => page.identity === identity && page.base === view.data ? page : { identity, base: view.data, trades: view.data?.trades ?? [], cursor: view.data?.nextCursor ?? null, hasMore: view.data?.hasMore ?? false }, [page, identity, view.data])
    const selectedRef = useRef(selected)
    selectedRef.current = selected
    useEffect(() => { pending.current = false; setLoadingMore(false); setLoadMoreError(null) }, [identity, view.data])
    const refresh = useCallback(async () => { setLoadMoreError(null); return refreshView(true) }, [refreshView])
    const loadMore = useCallback(async () => {
        const previous = selectedRef.current
        if (!scope || !enabled || pending.current || !previous.hasMore || !previous.cursor) return
        pending.current = true
        setLoadingMore(true)
        try {
            const next = await readScreenView<TradesView>({ ...scope, params: { ...scope.params, cursor: previous.cursor.token } })
            if (current.current !== identity || selectedRef.current !== previous) return
            const known = new Set(previous.trades.map(trade => trade.id))
            setPage({ ...previous, trades: [...previous.trades, ...next.trades.filter(trade => !known.has(trade.id))], cursor: next.nextCursor, hasMore: next.hasMore })
            setLoadMoreError(null)
        } catch (cause) {
            if (current.current === identity) setLoadMoreError(cause instanceof Error ? cause.message : 'Could not load more trades.')
        } finally { if (current.current === identity) { pending.current = false; setLoadingMore(false) } }
    }, [identity, scope, enabled])
    const updateTrades = useCallback((update: (trades: Trade[]) => Trade[]) => { const previous = selectedRef.current; setPage({ ...previous, trades: update(previous.trades) }) }, [])
    return { trades: selected.trades, hasData: view.loaded, loading: view.loading, refreshing: view.refreshing, loadingMore, hasMore: selected.hasMore, error: view.error?.message ?? null, isSnapshot: !view.loaded || view.offline || view.refreshing || Boolean(view.error), loadMoreError, refresh, loadMore, updateTrades }
}
