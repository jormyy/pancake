import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    addTradeBlockItem,
    getTradeBlockItems,
    removeTradeBlockItem,
    type TradeBlockItem,
    type TradePickItem,
} from '@/lib/trades'
import { getRoster, type RosterPlayer } from '@/lib/roster'
import { getErrorMessage } from '@/lib/alert'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { EMPTY_AVG_MAP, EMPTY_STATS_MAP, getRosterStatsMaps } from '@/lib/roster-stats'
import { isTradeableRosterPlayer } from '@/lib/trade-assets'

type TradeBlockCache = { items: TradeBlockItem[]; roster: RosterPlayer[] }

const TRADE_BLOCK_CACHE_PREFIX = 'pancake:trade-block:v1:'
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
    const [items, setItems] = useState<TradeBlockItem[]>(cached?.items ?? [])
    const [roster, setRoster] = useState<RosterPlayer[]>(cached?.roster ?? [])
    const [avgMap, setAvgMap] = useState(EMPTY_AVG_MAP)
    const [avgStatsMap, setAvgStatsMap] = useState(EMPTY_STATS_MAP)
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
            writePersistentCache(tradeBlockCacheKey(memberId, leagueId), { items: nextItems, roster: nextRoster })
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
        setAvgMap(EMPTY_AVG_MAP)
        setAvgStatsMap(EMPTY_STATS_MAP)
        setError(null)
        setBusyId(null)
        setLoading(!cached)
        setDataKey(resourceKey)
    }, [cached, resourceKey])

    useEffect(() => {
        const requestId = ++statsLoadSequence.current
        setAvgMap(EMPTY_AVG_MAP)
        setAvgStatsMap(EMPTY_STATS_MAP)
        if (!memberId || !leagueId || dataKey !== resourceKey || roster.length === 0) return

        const loadStats = async () => {
            try {
                const stats = await getRosterStatsMaps(roster.map((player) => player.players.id), leagueId)
                if (statsLoadSequence.current !== requestId) return
                setAvgMap(stats.avgMap)
                setAvgStatsMap(stats.avgStatsMap)
            } catch (statsError) {
                if (statsLoadSequence.current === requestId) {
                    console.warn('Could not load optional trade-block player averages.', statsError)
                }
            }
        }
        void loadStats()

        return () => {
            if (statsLoadSequence.current === requestId) statsLoadSequence.current += 1
        }
    }, [dataKey, leagueId, memberId, resourceKey, roster])

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
    return {
        items: ownsResource ? items : cached?.items ?? [],
        roster: ownsResource ? roster : cached?.roster ?? [],
        avgMap: ownsResource ? avgMap : EMPTY_AVG_MAP,
        avgStatsMap: ownsResource ? avgStatsMap : EMPTY_STATS_MAP,
        loading: ownsResource ? loading : !cached,
        error: ownsResource ? error : null,
        busyId: ownsResource ? busyId : null,
        refresh,
        addPlayer,
        addPick,
        removeItem,
    }
}
