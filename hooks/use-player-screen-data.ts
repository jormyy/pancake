import { useEffect, useState, useCallback, useRef } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { releaseLeagueDailyPending } from '@/lib/league-daily-cache'
import { deferLeagueRefresh, leagueResourceAffects, listenForLeagueChanges, waitForLeagueChanges } from '@/lib/league-changes'
import { sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'
import {
    getPlayer,
    getAvailableSeasons,
    getPlayerSeasonAveragesFromView,
    getPlayerGameLog,
    getPlayerFantasyPoints,
    getPlayerTransactionHistory,
    type GameLogEntry,
    type PlayerDetailRow,
    type PlayerSeasonAverages,
    type TransactionHistoryEntry,
} from '@/lib/players'
import { currentSeasonYear } from '@/lib/shared/season'
import { todayET } from '@/lib/shared/dates'
import { getErrorMessage } from '@/lib/shared/errors'
import { supabase } from '@/lib/supabase'
import { getPlayerProjection, type LeagueProjectionRow } from '@/lib/projections'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'

const GAME_LOG_PAGE = 15
const EMPTY_GAME_LOG: GameLogEntry[] = []
const EMPTY_SEASONS: number[] = []
const EMPTY_TRANSACTIONS: TransactionHistoryEntry[] = []
type SeasonCacheEntry = {
    seasonAverages: PlayerSeasonAverages | null
    gameLog: GameLogEntry[]
    gameLogOffset: number
    hasMoreGames: boolean
    fantasyPointsMap: Map<string, number> | null
    avgFantasyPoints: number
}
type PersistedSeasonCacheEntry = Omit<SeasonCacheEntry, 'fantasyPointsMap'> & {
    fantasyPointEntries: [string, number][] | null
}
type PlayerScreenCache = {
    today: string
    player: PlayerDetailRow | null
    playedToday: boolean
    availableSeasons: number[]
    selectedSeason: number
    seasons: [string, PersistedSeasonCacheEntry][]
    nextProjection: LeagueProjectionRow | null
    transactions: TransactionHistoryEntry[]
}
type PlayerScreenCacheState = Omit<PlayerScreenCache, 'today' | 'seasons'>

const PLAYER_SCREEN_CACHE_PREFIX = 'pancake:player-screen:v1:'

function errorMessage(error: unknown): string {
    return getErrorMessage(error) ?? 'Player data could not load.'
}

function seasonCacheKey(playerId: string, leagueId: string | null, season: number): string {
    return `${playerId}:${leagueId ?? 'no-league'}:${season}`
}

function playerScreenCacheKey(playerId: string, leagueId: string | null, owner: string) {
    return `${PLAYER_SCREEN_CACHE_PREFIX}${owner}:${leagueId ?? 'no-league'}:${playerId}`
}

function toPersistedSeasonEntry(entry: SeasonCacheEntry): PersistedSeasonCacheEntry {
    return {
        ...entry,
        fantasyPointEntries: entry.fantasyPointsMap ? Array.from(entry.fantasyPointsMap.entries()) : null,
    }
}

function fromPersistedSeasonEntry(entry: PersistedSeasonCacheEntry): SeasonCacheEntry {
    return {
        seasonAverages: entry.seasonAverages,
        gameLog: entry.gameLog,
        gameLogOffset: entry.gameLogOffset,
        hasMoreGames: entry.hasMoreGames,
        fantasyPointsMap: entry.fantasyPointEntries ? new Map(entry.fantasyPointEntries) : null,
        avgFantasyPoints: entry.avgFantasyPoints,
    }
}

function seasonCacheEntries(cache: PlayerScreenCache | undefined): [string, SeasonCacheEntry][] {
    return (cache?.seasons ?? []).map(([key, entry]) => [key, fromPersistedSeasonEntry(entry)])
}

function readPlayerScreenCache(playerId: string, leagueId: string | null, owner: string): PlayerScreenCache | undefined {
    const cached = readPersistentCache<PlayerScreenCache>(playerScreenCacheKey(playerId, leagueId, owner))
    if (!cached || cached.today !== todayET()) return undefined
    return cached
}

export function usePlayerScreenData(playerId: string, leagueId: string | null, options: { ownerKey?: string; authorized?: boolean } = {}) {
    const activity = useBrowserReadActivity()
    const [sourceEpoch, setSourceEpoch] = useState(0)
    const [focused, setFocused] = useState(false)
    useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false) }, []))
    const owner = options.ownerKey ?? sessionOwner() ?? 'anonymous'
    const generation = sessionGeneration()
    const resourceKey = JSON.stringify([owner, generation, leagueId, playerId])
    const activeKey = useRef(resourceKey)
    activeKey.current = resourceKey
    const authorized = options.authorized !== false
    const lifecycleEpoch = JSON.stringify([resourceKey, focused, activity.revision, authorized])
    const lifecycleRef = useRef(lifecycleEpoch)
    lifecycleRef.current = lifecycleEpoch
    const admittedRef = useRef<string | null>(null)
    const [admitted, setAdmitted] = useState<string | null>(null)
    const readEpoch = JSON.stringify([lifecycleEpoch, sourceEpoch, admitted === lifecycleEpoch])
    const lifecycleAdmission = useRef<() => boolean>(() => false)
    lifecycleAdmission.current = () => focused && authorized && activeKey.current === resourceKey
        && sessionGeneration() === generation && activity.isCurrent(activity.revision)
    const permits = () => lifecycleAdmission.current() && admittedRef.current === lifecycleEpoch
    const admission = useRef(permits)
    admission.current = permits
    const epochRef = useRef(readEpoch)
    epochRef.current = readEpoch
    const canRead = useCallback(() => admission.current(), [])
    const isCurrentRead = useCallback((epoch: string) => epochRef.current === epoch && admission.current(), [])
    useEffect(() => {
        admittedRef.current = null
        const current = lifecycleAdmission.current
        if (!current()) { setAdmitted(null); return }
        let disposed = false
        void (leagueId ? waitForLeagueChanges(leagueId) : Promise.resolve()).then(() => {
            if (disposed || !current() || lifecycleRef.current !== lifecycleEpoch) return
            admittedRef.current = lifecycleEpoch
            setAdmitted(lifecycleEpoch)
        })
        return () => {
            disposed = true
            if (admittedRef.current === lifecycleEpoch) admittedRef.current = null
        }
    }, [lifecycleEpoch, leagueId])
    useEffect(() => {
        if (!leagueId || !authorized) return
        const refresh = deferLeagueRefresh(() => { setSourceEpoch(epoch => epoch + 1) })
        let registering = true
        const stop = listenForLeagueChanges(leagueId, change => {
            if ((registering && change.topic === 'catchup') || !admission.current()) return
            if (leagueResourceAffects(change, ['averages', 'projections', 'scoring', 'season'])) refresh.trigger()
        })
        registering = false
        return () => { stop(); refresh.cancel() }
    }, [leagueId, resourceKey, authorized])
    useEffect(() => () => { if (leagueId) releaseLeagueDailyPending(leagueId) }, [leagueId, readEpoch])
    const initialCacheRef = useRef<{ loaded: boolean; value?: PlayerScreenCache }>({ loaded: false })
    if (!initialCacheRef.current.loaded) {
        initialCacheRef.current = { loaded: true, value: readPlayerScreenCache(playerId, leagueId, owner) }
    }
    const initialCache = initialCacheRef.current.value
    const initialSelectedSeason = initialCache?.selectedSeason ?? currentSeasonYear()
    const initialSeason = initialCache
        ? new Map(seasonCacheEntries(initialCache)).get(seasonCacheKey(playerId, leagueId, initialSelectedSeason))
        : undefined

    const [player, setPlayer] = useState<PlayerDetailRow | null>(initialCache?.player ?? null)
    const [loading, setLoading] = useState(!initialCache?.player)
    const [playerError, setPlayerError] = useState<string | null>(null)
    const [playedToday, setPlayedToday] = useState(initialCache?.playedToday ?? false)

    const [availableSeasons, setAvailableSeasons] = useState<number[]>(initialCache?.availableSeasons ?? [])
    const [selectedSeason, setSelectedSeason] = useState<number>(initialSelectedSeason)

    const [seasonAverages, setSeasonAverages] = useState<PlayerSeasonAverages | null>(initialSeason?.seasonAverages ?? null)
    const [seasonLoading, setSeasonLoading] = useState(!initialSeason)
    const [seasonError, setSeasonError] = useState<string | null>(null)

    const [gameLog, setGameLog] = useState<GameLogEntry[]>(initialSeason?.gameLog ?? [])
    const [gameLogOffset, setGameLogOffset] = useState(initialSeason?.gameLogOffset ?? 0)
    const [hasMoreGames, setHasMoreGames] = useState(initialSeason?.hasMoreGames ?? false)
    const [gameLogLoading, setGameLogLoading] = useState(false)
    const [gameLogError, setGameLogError] = useState<string | null>(null)

    const [fantasyPointsMap, setFantasyPointsMap] = useState<Map<string, number> | null>(initialSeason?.fantasyPointsMap ?? null)
    const [avgFantasyPoints, setAvgFantasyPoints] = useState(initialSeason?.avgFantasyPoints ?? 0)
    const [nextProjection, setNextProjection] = useState<LeagueProjectionRow | null>(initialCache?.nextProjection ?? null)
    const [projectionError, setProjectionError] = useState<string | null>(null)
    // "Settled" = the first fetch finished (or cache answered), so the screen
    // can hold off rendering until every card's presence is known at once.
    const [projectionSettled, setProjectionSettled] = useState(initialCache !== undefined || leagueId == null)

    const [transactions, setTransactions] = useState<TransactionHistoryEntry[]>(initialCache?.transactions ?? [])
    const [transactionsError, setTransactionsError] = useState<string | null>(null)
    const [transactionsSettled, setTransactionsSettled] = useState(initialCache !== undefined || leagueId == null)
    const [dataOwnerKey, setDataOwnerKey] = useState(resourceKey)
    const cacheStateRef = useRef<PlayerScreenCacheState>({
        player: initialCache?.player ?? null,
        playedToday: initialCache?.playedToday ?? false,
        availableSeasons: initialCache?.availableSeasons ?? [],
        selectedSeason: initialSelectedSeason,
        nextProjection: initialCache?.nextProjection ?? null,
        transactions: initialCache?.transactions ?? [],
    })
    const seasonCacheRef = useRef(new Map<string, SeasonCacheEntry>(seasonCacheEntries(initialCache)))
    const playerRequestRef = useRef(0)
    const seasonRequestRef = useRef(0)
    const gameLogRequestRef = useRef(0)
    const transactionRequestRef = useRef(0)

    const persistScreenCache = useCallback(() => {
        writePersistentCache<PlayerScreenCache>(playerScreenCacheKey(playerId, leagueId, owner), {
            today: todayET(),
            ...cacheStateRef.current,
            seasons: Array.from(seasonCacheRef.current.entries()).map(([key, entry]) => [
                key,
                toPersistedSeasonEntry(entry),
            ]),
        })
    }, [playerId, leagueId, owner])

    const applyScreenCache = useCallback((cache: PlayerScreenCache | undefined) => {
        seasonCacheRef.current = new Map(seasonCacheEntries(cache))
        const nextSelectedSeason = cache?.selectedSeason ?? currentSeasonYear()
        const nextSeason = seasonCacheRef.current.get(seasonCacheKey(playerId, leagueId, nextSelectedSeason))
        cacheStateRef.current = {
            player: cache?.player ?? null,
            playedToday: cache?.playedToday ?? false,
            availableSeasons: cache?.availableSeasons ?? [],
            selectedSeason: nextSelectedSeason,
            nextProjection: cache?.nextProjection ?? null,
            transactions: cache?.transactions ?? [],
        }
        setPlayer(cache?.player ?? null)
        setLoading(!cache?.player)
        setPlayerError(null)
        setPlayedToday(cache?.playedToday ?? false)
        setAvailableSeasons(cache?.availableSeasons ?? [])
        setSelectedSeason(nextSelectedSeason)
        setSeasonAverages(nextSeason?.seasonAverages ?? null)
        setSeasonLoading(false)
        setSeasonError(null)
        setGameLog(nextSeason?.gameLog ?? [])
        setGameLogOffset(nextSeason?.gameLogOffset ?? 0)
        setHasMoreGames(nextSeason?.hasMoreGames ?? false)
        setGameLogLoading(false)
        setGameLogError(null)
        setFantasyPointsMap(nextSeason?.fantasyPointsMap ?? null)
        setAvgFantasyPoints(nextSeason?.avgFantasyPoints ?? 0)
        setNextProjection(cache?.nextProjection ?? null)
        setProjectionError(null)
        setProjectionSettled(cache !== undefined)
        setTransactions(cache?.transactions ?? [])
        setTransactionsError(null)
        setTransactionsSettled(cache !== undefined)
    }, [playerId, leagueId])

    useEffect(() => {
        applyScreenCache(readPlayerScreenCache(playerId, leagueId, owner))
        setDataOwnerKey(resourceKey)
    }, [resourceKey, playerId, leagueId, owner, applyScreenCache])

    useEffect(() => {
        const requestId = ++playerRequestRef.current
        const current = admission.current
        if (!current()) return
        setLoading(!cacheStateRef.current.player)
        async function load() {
            try {
                const [p, seasons, todayStats] = await Promise.all([
                    getPlayer(playerId),
                    getAvailableSeasons(playerId),
                    supabase
                        .from('player_game_stats')
                        .select('did_not_play')
                        .eq('player_id', playerId)
                        // player_game_stats.game_date is ET-keyed (backend writes via todayET());
                        // use todayET so non-ET clients don't query against the wrong date.
                        .eq('game_date', todayET())
                        .maybeSingle(),
                ])
                if (playerRequestRef.current !== requestId || !current()) return
                if (todayStats.error) throw todayStats.error
                const didPlayToday = todayStats.data != null && todayStats.data.did_not_play === false
                setPlayedToday(didPlayToday)
                setPlayer(p)
                setAvailableSeasons(seasons)
                const currentYear = currentSeasonYear()
                const currentSelectedSeason = cacheStateRef.current.selectedSeason
                const nextSelectedSeason = seasons.includes(currentSelectedSeason)
                    ? currentSelectedSeason
                    : seasons.length > 0 && !seasons.includes(currentYear)
                    ? seasons[0]
                    : currentYear
                const nextSeason = seasonCacheRef.current.get(seasonCacheKey(playerId, leagueId, nextSelectedSeason))
                setSelectedSeason(nextSelectedSeason)
                setSeasonAverages(nextSeason?.seasonAverages ?? null)
                setGameLog(nextSeason?.gameLog ?? [])
                setGameLogOffset(nextSeason?.gameLogOffset ?? 0)
                setHasMoreGames(nextSeason?.hasMoreGames ?? false)
                setFantasyPointsMap(nextSeason?.fantasyPointsMap ?? null)
                setAvgFantasyPoints(nextSeason?.avgFantasyPoints ?? 0)
                setSeasonLoading(!nextSeason)
                cacheStateRef.current = {
                    ...cacheStateRef.current,
                    player: p,
                    playedToday: didPlayToday,
                    availableSeasons: seasons,
                    selectedSeason: nextSelectedSeason,
                }
                persistScreenCache()
                setPlayerError(null)
            } catch (e) {
                if (playerRequestRef.current !== requestId || !current()) return
                setPlayerError(errorMessage(e))
            } finally {
                if (playerRequestRef.current === requestId && current()) setLoading(false)
            }
        }
        void load()
        return () => { playerRequestRef.current += 1 }
    }, [playerId, leagueId, persistScreenCache, resourceKey, readEpoch])

    const ownsResource = dataOwnerKey === resourceKey

    const loadedPlayerId = player?.id
    const playerTeam = player?.nba_team ?? null

    useEffect(() => {
        const current = admission.current
        if (!current() || dataOwnerKey !== resourceKey || loadedPlayerId !== playerId) return
        const key = seasonCacheKey(playerId, leagueId, selectedSeason)
        const requestId = ++seasonRequestRef.current
        gameLogRequestRef.current += 1
        setGameLogLoading(false)
        setGameLogError(null)
        const cached = seasonCacheRef.current.get(key)
        if (cached) {
            setSeasonAverages(cached.seasonAverages)
            setGameLog(cached.gameLog)
            setGameLogOffset(cached.gameLogOffset)
            setHasMoreGames(cached.hasMoreGames)
            setFantasyPointsMap(cached.fantasyPointsMap)
            setAvgFantasyPoints(cached.avgFantasyPoints)
            setSeasonLoading(false)
        } else {
            setSeasonAverages(null)
            setGameLog([])
            setGameLogOffset(0)
            setHasMoreGames(false)
            setFantasyPointsMap(null)
            setAvgFantasyPoints(0)
            setSeasonLoading(true)
        }
        async function loadSeasonData() {
            try {
                const [avgs, gameLogResult, fantasyPoints] = await Promise.all([
                    getPlayerSeasonAveragesFromView(playerId, selectedSeason),
                    getPlayerGameLog(playerId, playerTeam, selectedSeason, GAME_LOG_PAGE, 0),
                    leagueId ? getPlayerFantasyPoints(playerId, leagueId, selectedSeason) : Promise.resolve(null),
                ])
                if (seasonRequestRef.current !== requestId || !current()) return
                const fpMap = fantasyPoints ? new Map(fantasyPoints.map((p) => [p.gameId, p.fantasyPoints])) : null
                const avgFantasy = fantasyPoints && fantasyPoints.length > 0
                    ? fantasyPoints.reduce((sum, p) => sum + p.fantasyPoints, 0) / fantasyPoints.length
                    : 0
                const entry = {
                    seasonAverages: avgs,
                    gameLog: gameLogResult.games,
                    gameLogOffset: gameLogResult.games.length,
                    hasMoreGames: gameLogResult.hasMore,
                    fantasyPointsMap: fpMap,
                    avgFantasyPoints: avgFantasy,
                }
                seasonCacheRef.current.set(key, entry)
                persistScreenCache()
                setSeasonAverages(avgs)
                setGameLog(gameLogResult.games)
                setGameLogOffset(gameLogResult.games.length)
                setHasMoreGames(gameLogResult.hasMore)
                setFantasyPointsMap(fpMap)
                setAvgFantasyPoints(avgFantasy)
                setSeasonError(null)
            } catch (e) {
                if (seasonRequestRef.current === requestId && current()) setSeasonError(errorMessage(e))
            } finally {
                if (seasonRequestRef.current === requestId && current()) setSeasonLoading(false)
            }
        }
        void loadSeasonData()
        return () => { seasonRequestRef.current += 1; gameLogRequestRef.current += 1 }
    }, [playerId, leagueId, selectedSeason, loadedPlayerId, playerTeam, persistScreenCache, dataOwnerKey, resourceKey, readEpoch])

    // Load transaction history
    useEffect(() => {
        const requestId = ++transactionRequestRef.current
        const current = admission.current
        if (!current()) return
        if (!leagueId) {
            setTransactions([])
            setTransactionsError(null)
            setTransactionsSettled(true)
            cacheStateRef.current = { ...cacheStateRef.current, transactions: [] }
            return
        }
        async function loadTransactions() {
            try {
                const tx = await getPlayerTransactionHistory(playerId, leagueId!)
                if (transactionRequestRef.current !== requestId || !current()) return
                setTransactions(tx)
                cacheStateRef.current = { ...cacheStateRef.current, transactions: tx }
                persistScreenCache()
                setTransactionsError(null)
            } catch (e) {
                if (transactionRequestRef.current !== requestId || !current()) return
                setTransactionsError(errorMessage(e))
            } finally {
                if (transactionRequestRef.current === requestId && current()) setTransactionsSettled(true)
            }
        }
        void loadTransactions()
        return () => { transactionRequestRef.current += 1 }
    }, [playerId, leagueId, persistScreenCache, readEpoch])

    useEffect(() => {
        let cancelled = false
        const current = admission.current
        if (!current()) return
        if (!cacheStateRef.current.nextProjection || cacheStateRef.current.nextProjection.player_id !== playerId) {
            setNextProjection(null)
        }
        if (!leagueId) {
            setProjectionSettled(true)
            cacheStateRef.current = { ...cacheStateRef.current, nextProjection: null }
            return
        }

        getPlayerProjection(playerId, leagueId)
            .then((projection) => {
                if (!cancelled && current()) {
                    setNextProjection(projection)
                    cacheStateRef.current = { ...cacheStateRef.current, nextProjection: projection }
                    persistScreenCache()
                    setProjectionError(null)
                }
            })
            .catch((error) => {
                if (!cancelled && current()) setProjectionError(errorMessage(error))
            })
            .finally(() => {
                if (!cancelled && current()) setProjectionSettled(true)
            })

        return () => { cancelled = true }
    }, [playerId, leagueId, persistScreenCache, readEpoch])

    const loadMoreGames = useCallback(async () => {
        if (!admission.current() || !ownsResource || gameLogLoading || !hasMoreGames || !player) return
        const current = admission.current
        const requestId = ++gameLogRequestRef.current
        setGameLogLoading(true)
        try {
            const result = await getPlayerGameLog(
                playerId,
                player.nba_team,
                selectedSeason,
                GAME_LOG_PAGE,
                gameLogOffset,
            )
            if (gameLogRequestRef.current !== requestId || !current()) return
            setGameLog((prev) => {
                const merged = [...prev, ...result.games]
                const key = seasonCacheKey(playerId, leagueId, selectedSeason)
                const cached = seasonCacheRef.current.get(key)
                if (cached) {
                    seasonCacheRef.current.set(key, {
                        ...cached,
                        gameLog: merged,
                        gameLogOffset: gameLogOffset + result.games.length,
                        hasMoreGames: result.hasMore,
                    })
                    persistScreenCache()
                }
                return merged
            })
            setGameLogOffset(gameLogOffset + result.games.length)
            setHasMoreGames(result.hasMore)
            setGameLogError(null)
        } catch (e) {
            if (gameLogRequestRef.current === requestId && current()) setGameLogError(errorMessage(e))
        } finally {
            if (gameLogRequestRef.current === requestId && current()) setGameLogLoading(false)
        }
    }, [playerId, leagueId, player, selectedSeason, gameLogOffset, gameLogLoading, hasMoreGames, ownsResource, persistScreenCache])

    function handleSeasonSelect(year: number) {
        if (!ownsResource) return
        if (year !== selectedSeason) {
            setSelectedSeason(year)
            cacheStateRef.current = { ...cacheStateRef.current, selectedSeason: year }
            persistScreenCache()
        }
    }

    return {
        canRead,
        readEpoch,
        isCurrentRead,
        player: ownsResource ? player : null,
        loading: ownsResource ? loading : true,
        playedToday: ownsResource ? playedToday : false,
        playerError: ownsResource ? playerError : null,
        availableSeasons: ownsResource ? availableSeasons : EMPTY_SEASONS,
        selectedSeason: ownsResource ? selectedSeason : currentSeasonYear(),
        handleSeasonSelect,
        seasonAverages: ownsResource ? seasonAverages : null,
        seasonLoading: ownsResource ? seasonLoading : true,
        seasonError: ownsResource ? seasonError : null,
        gameLog: ownsResource ? gameLog : EMPTY_GAME_LOG,
        hasMoreGames: ownsResource ? hasMoreGames : false,
        gameLogLoading: ownsResource ? gameLogLoading : false,
        loadMoreGames,
        gameLogError: ownsResource ? gameLogError : null,
        fantasyPointsMap: ownsResource ? fantasyPointsMap : null,
        avgFantasyPoints: ownsResource ? avgFantasyPoints : 0,
        nextProjection: ownsResource ? nextProjection : null,
        projectionError: ownsResource ? projectionError : null,
        projectionSettled: ownsResource ? projectionSettled : false,
        transactions: ownsResource ? transactions : EMPTY_TRANSACTIONS,
        transactionsError: ownsResource ? transactionsError : null,
        transactionsSettled: ownsResource ? transactionsSettled : false,
    }
}
