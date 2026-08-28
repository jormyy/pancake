import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    addTradeBlockItem,
    getTradeBlockItems,
    removeTradeBlockItem,
    withTradeBlockStats,
    type TradeBlockItem,
    type TradePickItem,
} from '@/lib/trades'
import { getRoster, type RosterPlayer } from '@/lib/roster'
import { getErrorMessage } from '@/lib/shared/errors'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { EMPTY_AVG_MAP, EMPTY_STATS_MAP, getRosterStatsMaps, type RosterAverage } from '@/lib/roster-stats'
import { isTradeableRosterPlayer } from '@/lib/trade-assets'

type TradeBlockCache = {
    items: TradeBlockItem[]
    roster: RosterPlayer[]
    avgEntries: [string, number][]
    avgStatsEntries: [string, RosterAverage][]
}

const TRADE_BLOCK_CACHE_PREFIX = 'pancake:trade-block:v2:'
const tradeBlockCacheKey = (memberId: string, leagueId: string) =>
    `${TRADE_BLOCK_CACHE_PREFIX}${leagueId}:${memberId}`

export function useTradeBlock(memberId: string, leagueId: string) {
    const resourceKey = memberId && leagueId ? tradeBlockCacheKey(memberId, leagueId) : null
    const cached = useMemo(
        () => memberId && leagueId
            ? readPersistentCache<TradeBlockCache>(tradeBlockCacheKey(memberId, leagueId))
            : null,
        [memberId, leagueId],
    )
    const cachedAvgMap = useMemo(() => cached ? new Map(cached.avgEntries) : EMPTY_AVG_MAP, [cached])
    const cachedAvgStatsMap = useMemo(() => cached ? new Map(cached.avgStatsEntries) : EMPTY_STATS_MAP, [cached])
    const [items, setItems] = useState<TradeBlockItem[]>(cached?.items ?? [])
    const [roster, setRoster] = useState<RosterPlayer[]>(cached?.roster ?? [])
    const [avgMap, setAvgMap] = useState(cachedAvgMap)
    const [avgStatsMap, setAvgStatsMap] = useState(cachedAvgStatsMap)
    const [loading, setLoading] = useState(!cached)
    const [error, setError] = useState<string | null>(null)
    const [busyId, setBusyId] = useState<string | null>(null)
    const loadSequence = useRef(0)
    const statsLoadSequence = useRef(0)
    const mutationGeneration = useRef(0)
    const mutationQueue = useRef<Promise<void>>(Promise.resolve())
    const [dataKey, setDataKey] = useState<string | null>(resourceKey)

    const refresh = useCallback(async () => {
        const requestId = ++loadSequence.current
        if (!memberId || !leagueId) {
            setItems([])
            setRoster([])
            setAvgMap(EMPTY_AVG_MAP)
            setAvgStatsMap(EMPTY_STATS_MAP)
            setError(null)
            setLoading(false)
            setDataKey(null)
            return
        }
        setLoading(true)
        setError(null)
        try {
            const [nextItems, memberRoster] = await Promise.all([
                getTradeBlockItems(leagueId),
                getRoster(memberId, leagueId),
            ])
            if (loadSequence.current !== requestId) return
            const nextRoster = memberRoster.filter(isTradeableRosterPlayer)
            setItems(nextItems)
            setRoster(nextRoster)
            setAvgMap(EMPTY_AVG_MAP)
            setAvgStatsMap(EMPTY_STATS_MAP)
            setDataKey(resourceKey)
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
        statsLoadSequence.current += 1
        mutationGeneration.current += 1
        mutationQueue.current = Promise.resolve()
        setItems(cached?.items ?? [])
        setRoster(cached?.roster ?? [])
        setAvgMap(cachedAvgMap)
        setAvgStatsMap(cachedAvgStatsMap)
        setError(null)
        setBusyId(null)
        setLoading(!cached)
        setDataKey(resourceKey)
    }, [cached, cachedAvgMap, cachedAvgStatsMap, resourceKey])

    // One averages fetch covers the league's listed players and the member's
    // own roster; the listings and roster render before it lands, and the cache
    // is written once the averages are known (or known to be missing).
    useEffect(() => {
        const requestId = ++statsLoadSequence.current
        if (!memberId || !leagueId || dataKey !== resourceKey) return
        const playerIds = [...new Set([
            ...items.flatMap((item) => item.asset.kind === 'player' ? [item.asset.playerId] : []),
            ...roster.map((player) => player.players.id),
        ])]
        const persist = (avg: Map<string, number>, stats: Map<string, RosterAverage>) => writePersistentCache(tradeBlockCacheKey(memberId, leagueId), {
            items, roster, avgEntries: Array.from(avg.entries()), avgStatsEntries: Array.from(stats.entries()),
        })
        if (playerIds.length === 0) {
            persist(EMPTY_AVG_MAP, EMPTY_STATS_MAP)
            return
        }

        const loadStats = async () => {
            try {
                const stats = await getRosterStatsMaps(playerIds, leagueId)
                if (statsLoadSequence.current !== requestId) return
                setAvgMap(stats.avgMap)
                setAvgStatsMap(stats.avgStatsMap)
                persist(stats.avgMap, stats.avgStatsMap)
            } catch (statsError) {
                if (statsLoadSequence.current !== requestId) return
                console.warn('Could not load optional trade-block player averages.', statsError)
                persist(EMPTY_AVG_MAP, EMPTY_STATS_MAP)
            }
        }
        void loadStats()

        return () => {
            if (statsLoadSequence.current === requestId) statsLoadSequence.current += 1
        }
    }, [dataKey, items, leagueId, memberId, resourceKey, roster])

    useEffect(() => () => {
        loadSequence.current += 1
        statsLoadSequence.current += 1
        mutationGeneration.current += 1
        mutationQueue.current = Promise.resolve()
    }, [])

    const mutate = useCallback(async (id: string, operation: () => Promise<unknown>) => {
        const generation = mutationGeneration.current
        const task = mutationQueue.current.then(async () => {
            if (mutationGeneration.current !== generation) return
            setBusyId(id)
            try {
                await operation()
                if (mutationGeneration.current === generation) await refresh()
            } catch (cause) {
                if (mutationGeneration.current === generation) {
                    setError(getErrorMessage(cause) ?? 'Could not update trade block.')
                }
            } finally {
                if (mutationGeneration.current === generation) setBusyId(null)
            }
        })
        mutationQueue.current = task.catch(() => {})
        return task
    }, [refresh])

    const addPlayer = useCallback((player: RosterPlayer) => {
        if (!memberId || !leagueId) return Promise.resolve()
        return mutate(player.players.id, () => addTradeBlockItem({
            memberId,
            leagueId,
            playerId: player.players.id,
        }))
    }, [memberId, leagueId, mutate])

    const addPick = useCallback((pick: TradePickItem) => {
        if (!memberId || !leagueId) return Promise.resolve()
        return mutate(pick.pickId, () => addTradeBlockItem({ memberId, leagueId, pickId: pick.pickId }))
    }, [memberId, leagueId, mutate])

    const removeItem = useCallback((item: TradeBlockItem) => {
        if (!memberId) return Promise.resolve()
        return mutate(item.id, () => removeTradeBlockItem(item.id, memberId))
    }, [memberId, mutate])

    const ownsResource = dataKey === resourceKey
    const itemsWithStats = useMemo(() => withTradeBlockStats(
        ownsResource ? items : cached?.items ?? [],
        ownsResource ? avgMap : cachedAvgMap,
        ownsResource ? avgStatsMap : cachedAvgStatsMap,
    ), [ownsResource, items, cached, avgMap, avgStatsMap, cachedAvgMap, cachedAvgStatsMap])
    return {
        items: itemsWithStats,
        roster: ownsResource ? roster : cached?.roster ?? [],
        avgMap: ownsResource ? avgMap : cachedAvgMap,
        avgStatsMap: ownsResource ? avgStatsMap : cachedAvgStatsMap,
        loading: ownsResource ? loading : !cached,
        error: ownsResource ? error : null,
        busyId: ownsResource ? busyId : null,
        refresh,
        addPlayer,
        addPick,
        removeItem,
    }
}
