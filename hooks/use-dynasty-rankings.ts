import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import {
    DYNASTY_RANKINGS_PAGE_SIZE,
    getDynastyRankingsPage,
    type DynastyRankPlayer,
} from '@/lib/dynasty'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'

const STALE_MS = 5 * 60_000
const DYNASTY_CACHE_PREFIX = 'pancake:dynasty-rankings:v1:'

type DynastyRankingsCache = {
    players: DynastyRankPlayer[]
    hasMore: boolean
    offset: number
    savedAt: number
}

const dynastyCacheKey = (query: string) => `${DYNASTY_CACHE_PREFIX}${query.trim().toLocaleLowerCase()}`

export function useDynastyRankings() {
    const [query, setQuery] = useState('')
    const [initialCache] = useState(() => readPersistentCache<DynastyRankingsCache>(dynastyCacheKey('')))
    const [players, setPlayers] = useState<DynastyRankPlayer[]>(initialCache?.players ?? [])
    const [loading, setLoading] = useState(!initialCache)
    const [refreshing, setRefreshing] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)
    const [hasMore, setHasMore] = useState(initialCache?.hasMore ?? false)
    const [error, setError] = useState<Error | null>(null)
    const [loadMoreError, setLoadMoreError] = useState<Error | null>(null)
    const debouncedQuery = useDebouncedValue(query, 250)
    const requestSeqRef = useRef(0)
    const loadMoreSeqRef = useRef(0)
    const offsetRef = useRef(initialCache?.offset ?? 0)
    const queryRef = useRef('')
    const lastLoadedAtRef = useRef(initialCache?.savedAt ?? 0)
    const playersRef = useRef<DynastyRankPlayer[]>(initialCache?.players ?? [])
    const firstPageInFlightRef = useRef<string | null>(null)

    useEffect(() => {
        playersRef.current = players
    }, [players])

    const invalidateLoadMore = useCallback(() => {
        ++loadMoreSeqRef.current
        setLoadingMore(false)
    }, [])

    const loadFirstPage = useCallback(async (loadQuery: string, force = false) => {
        const hasRows = playersRef.current.length > 0
        const fresh = Date.now() - lastLoadedAtRef.current < STALE_MS
        if (!force && hasRows && fresh && loadQuery === queryRef.current) return
        if (!force && firstPageInFlightRef.current === loadQuery) return

        const requestId = ++requestSeqRef.current
        invalidateLoadMore()
        firstPageInFlightRef.current = loadQuery
        queryRef.current = loadQuery
        offsetRef.current = 0
        setError(null)
        setLoadMoreError(null)
        setHasMore(false)
        setLoading(hasRows ? false : true)
        setRefreshing(hasRows)

        try {
            const page = await getDynastyRankingsPage({ query: loadQuery, offset: 0 })
            if (requestSeqRef.current !== requestId || queryRef.current !== loadQuery) return
            playersRef.current = page.players
            setPlayers(page.players)
            setHasMore(page.hasMore)
            lastLoadedAtRef.current = Date.now()
            writePersistentCache<DynastyRankingsCache>(dynastyCacheKey(loadQuery), {
                players: page.players,
                hasMore: page.hasMore,
                offset: 0,
                savedAt: lastLoadedAtRef.current,
            })
        } catch (e) {
            if (requestSeqRef.current !== requestId) return
            const nextError = e instanceof Error ? e : new Error(String(e))
            setError(nextError)
            console.error(nextError)
        } finally {
            if (requestSeqRef.current === requestId) {
                setLoading(false)
                setRefreshing(false)
            }
            if (firstPageInFlightRef.current === loadQuery) firstPageInFlightRef.current = null
        }
    }, [invalidateLoadMore])

    useEffect(() => {
        const cached = readPersistentCache<DynastyRankingsCache>(dynastyCacheKey(debouncedQuery))
        if (cached) {
            playersRef.current = cached.players
            offsetRef.current = cached.offset
            lastLoadedAtRef.current = cached.savedAt
            setPlayers(cached.players)
            setHasMore(cached.hasMore)
            setLoading(false)
        } else {
            playersRef.current = []
            offsetRef.current = 0
            lastLoadedAtRef.current = 0
            setPlayers([])
            setHasMore(false)
            setLoading(true)
        }
        void loadFirstPage(debouncedQuery, true)
    }, [debouncedQuery, loadFirstPage])

    useFocusEffect(
        useCallback(() => {
            void loadFirstPage(queryRef.current)
        }, [loadFirstPage]),
    )

    const loadMore = useCallback(async (options: { force?: boolean } = {}) => {
        if (loading || loadingMore || !hasMore) return
        if (loadMoreError && !options.force) return

        const loadQuery = queryRef.current
        const nextOffset = offsetRef.current + DYNASTY_RANKINGS_PAGE_SIZE
        const requestId = ++loadMoreSeqRef.current
        setLoadingMore(true)
        setLoadMoreError(null)

        try {
            const page = await getDynastyRankingsPage({ query: loadQuery, offset: nextOffset })
            if (loadMoreSeqRef.current !== requestId || queryRef.current !== loadQuery) return
            offsetRef.current = nextOffset
            setPlayers((prev) => {
                const merged = [...prev, ...page.players]
                playersRef.current = merged
                writePersistentCache<DynastyRankingsCache>(dynastyCacheKey(loadQuery), {
                    players: merged,
                    hasMore: page.hasMore,
                    offset: nextOffset,
                    savedAt: Date.now(),
                })
                return merged
            })
            setHasMore(page.hasMore)
        } catch (e) {
            if (loadMoreSeqRef.current !== requestId) return
            const nextError = e instanceof Error ? e : new Error(String(e))
            setLoadMoreError(nextError)
            console.error(nextError)
        } finally {
            if (loadMoreSeqRef.current === requestId) setLoadingMore(false)
        }
    }, [hasMore, loadMoreError, loading, loadingMore])

    const refresh = useCallback(() => loadFirstPage(queryRef.current, true), [loadFirstPage])
    const retryLoadMore = useCallback(() => loadMore({ force: true }), [loadMore])

    return {
        query,
        setQuery,
        players,
        loading,
        refreshing,
        loadingMore,
        hasMore,
        error,
        loadMoreError,
        loadMore,
        retryLoadMore,
        refresh,
    }
}
