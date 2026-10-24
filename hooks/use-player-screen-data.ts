import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useIsFocused } from '@react-navigation/native'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { releaseLeagueDailyPending } from '@/lib/league-daily-cache'
import { deferLeagueRefresh, leagueResourceAffects, listenForLeagueChanges } from '@/lib/league-changes'
import { sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'
import { getPlayer, getAvailableSeasons, getPlayerTransactionHistory, type PlayerDetailRow, type TransactionHistoryEntry } from '@/lib/players'
import { getPlayerSeasonLines, getPlayerScoringSettings, summarizePlayerSeason, type PlayerSeasonLine } from '@/components/player/season-data'
import { currentSeasonYear } from '@/lib/shared/season'
import { todayET } from '@/lib/shared/dates'
import { getErrorMessage } from '@/lib/shared/errors'
import { getPlayerProjection, type LeagueProjectionRow } from '@/lib/projections'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'

const GAME_LOG_PAGE = 15
const EMPTY_LINES: PlayerSeasonLine[] = []
const EMPTY_SEASONS: number[] = []
const EMPTY_TRANSACTIONS: TransactionHistoryEntry[] = []
type PlayerScreenCache = {
    today: string
    player?: PlayerDetailRow
    availableSeasons?: number[]
    selectedSeason: number
    seasons: [number, PlayerSeasonLine[]][]
    nextProjection?: LeagueProjectionRow | null
    transactions?: TransactionHistoryEntry[]
}
const PLAYER_SCREEN_CACHE_PREFIX = 'pancake:player-screen:v2:'

function useScreenResource<Value>(key: string, readEpoch: string, refresh: number, initial: Value | undefined, read: () => Promise<Value>, canRead: () => boolean) {
    const [state, setState] = useState({ key, value: initial, settled: initial !== undefined, error: null as string | null })
    const initialValue = useRef(initial)
    initialValue.current = initial
    const current = useRef<string | null>(null)
    const identity = JSON.stringify([key, readEpoch])
    current.current = identity
    const pending = useRef<{ identity: string; queued: boolean } | null>(null)
    useEffect(() => () => { current.current = null }, [])
    useEffect(() => {
        if (!canRead()) return
        if (pending.current?.identity === identity) {
            pending.current.queued = true
            return
        }
        const request = { identity, queued: false }
        pending.current = request
        const isCurrent = () => current.current === identity && canRead()
        async function load() {
            do {
                request.queued = false
                try {
                    const value = await read()
                    if (!isCurrent()) return
                    setState({ key, value, settled: true, error: null })
                } catch (error) {
                    if (!isCurrent()) return
                    setState(previous => ({ key, value: previous.key === key ? previous.value : initialValue.current,
                        settled: true, error: getErrorMessage(error) }))
                }
            } while (request.queued && isCurrent())
            if (pending.current === request) pending.current = null
        }
        void load()
    }, [key, identity, refresh, read, canRead])
    return state.key === key ? state : { key, value: initial, settled: initial !== undefined, error: null }
}

export function usePlayerScreenData(playerId: string, leagueId: string | null, options: { ownerKey?: string; authorized?: boolean; scoringSettings?: unknown } = {}) {
    const activity = useBrowserReadActivity()
    const focused = useIsFocused()
    const routeActivity = useRef({ focused, revision: 0 })
    if (routeActivity.current.focused !== focused) {
        routeActivity.current = { focused, revision: routeActivity.current.revision + 1 }
    }
    const owner = options.ownerKey ?? sessionOwner() ?? 'anonymous'
    const generation = sessionGeneration()
    const resourceKey = JSON.stringify([owner, generation, leagueId, playerId])
    const authorized = options.authorized !== false
    const readEpoch = JSON.stringify([resourceKey, routeActivity.current.revision, activity.revision, authorized])
    const admission = useRef<() => boolean>(() => false)
    admission.current = () => focused && authorized && sessionGeneration() === generation && activity.isCurrent(activity.revision)
    const epochRef = useRef(readEpoch)
    epochRef.current = readEpoch
    const canRead = useCallback(() => admission.current(), [])
    const isCurrentRead = useCallback((epoch: string) => epochRef.current === epoch && admission.current(), [])
    const selectedSeasonRef = useRef(currentSeasonYear())
    const [refreshes, setRefreshes] = useState({ profile: 0, season: 0, projection: 0, history: 0, roster: 0, scoring: 0 })
    useEffect(() => {
        if (!leagueId || !authorized) return
        const queued = new Set<keyof typeof refreshes>()
        const refresh = deferLeagueRefresh(() => {
            const resources = new Set(queued)
            queued.clear()
            setRefreshes(previous => ({
                profile: previous.profile + Number(resources.has('profile')),
                season: previous.season + Number(resources.has('season')),
                projection: previous.projection + Number(resources.has('projection')),
                history: previous.history + Number(resources.has('history')),
                roster: previous.roster + Number(resources.has('roster')),
                scoring: previous.scoring + Number(resources.has('scoring')),
            }))
        })
        let registering = true
        const stop = listenForLeagueChanges(leagueId, change => {
            if ((registering && change.topic === 'catchup') || !canRead()) return
            if (selectedSeasonRef.current === currentSeasonYear() &&
                (change.topic === 'stat' || change.topic === 'game' || leagueResourceAffects(change, ['averages', 'season']))) queued.add('season')
            if (change.topic === 'game' || leagueResourceAffects(change, ['projections', 'season'])) queued.add('projection')
            if (leagueResourceAffects(change, ['averages', 'season'])) queued.add('profile')
            if (leagueResourceAffects(change, ['scoring'])) queued.add('scoring')
            if (change.topic === 'roster' || change.topic === 'inventory' || change.topic === 'catchup') {
                queued.add('roster')
                queued.add('history')
            }
            if (queued.size) refresh.trigger()
        })
        registering = false
        return () => { stop(); refresh.cancel() }
    }, [leagueId, resourceKey, authorized, canRead])
    useEffect(() => () => { if (leagueId) releaseLeagueDailyPending(leagueId) }, [leagueId, readEpoch])
    const cacheKey = `${PLAYER_SCREEN_CACHE_PREFIX}${owner}:${leagueId ?? 'no-league'}:${playerId}`
    const cache = useMemo(() => {
        const saved = readPersistentCache<PlayerScreenCache>(cacheKey)
        return saved?.today === todayET() ? saved : undefined
    }, [cacheKey])
    const [selection, setSelection] = useState({ key: resourceKey, year: cache?.selectedSeason ?? currentSeasonYear() })
    const selectedSeason = selection.key === resourceKey ? selection.year : cache?.selectedSeason ?? currentSeasonYear()
    selectedSeasonRef.current = selectedSeason
    const seasonCache = useMemo(() => ({ owner: resourceKey, entries: new Map(cache?.seasons ?? []) }), [cache, resourceKey])
    const [visibleGames, setVisibleGames] = useState({ key: '', count: GAME_LOG_PAGE })
    const seasonKey = JSON.stringify([resourceKey, selectedSeason])
    const readPlayer = useCallback(() => getPlayer(playerId), [playerId])
    const readSeasons = useCallback(() => getAvailableSeasons(playerId), [playerId])
    const readLines = useCallback(async () => {
        const next = await getPlayerSeasonLines(playerId, selectedSeason)
        const previous = seasonCache.entries.get(selectedSeason)
        return previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next
    }, [playerId, selectedSeason, seasonCache])
    const suppliedScoringKey = JSON.stringify(options.scoringSettings ?? null)
    const readScoring = useCallback(() => suppliedScoringKey !== 'null' && refreshes.scoring === 0
        ? Promise.resolve(JSON.parse(suppliedScoringKey) as unknown)
        : leagueId ? getPlayerScoringSettings(leagueId) : Promise.resolve(null), [leagueId, suppliedScoringKey, refreshes.scoring])
    const readProjection = useCallback(() => leagueId ? getPlayerProjection(playerId, leagueId) : Promise.resolve(null), [playerId, leagueId])
    const readTransactions = useCallback(() => leagueId ? getPlayerTransactionHistory(playerId, leagueId) : Promise.resolve(EMPTY_TRANSACTIONS), [playerId, leagueId])
    const player = useScreenResource(resourceKey, readEpoch, refreshes.profile, cache?.player, readPlayer, canRead)
    const seasons = useScreenResource(resourceKey, readEpoch, refreshes.profile, cache?.availableSeasons, readSeasons, canRead)
    const lines = useScreenResource(seasonKey, readEpoch, refreshes.season, seasonCache.entries.get(selectedSeason), readLines, canRead)
    const projection = useScreenResource(resourceKey, readEpoch, refreshes.projection, cache?.nextProjection, readProjection, canRead)
    const history = useScreenResource(resourceKey, readEpoch, refreshes.history, cache?.transactions, readTransactions, canRead)
    const availableSeasons = useMemo(() => Array.from(new Set([currentSeasonYear(), ...(seasons.value ?? EMPTY_SEASONS)])).sort((a, b) => b - a), [seasons.value])
    const scoringSettings = useScreenResource<unknown>(resourceKey, readEpoch, refreshes.scoring, options.scoringSettings, readScoring, canRead)
    const scoringKey = JSON.stringify(scoringSettings.value ?? null)
    const scoring = useMemo(() => {
        const value: unknown = JSON.parse(scoringKey)
        if (!leagueId || !value || typeof value !== 'object' || Array.isArray(value)) return null
        const settings: Record<string, number> = {}
        for (const [key, coefficient] of Object.entries(value)) {
            if (typeof coefficient === 'number' && Number.isFinite(coefficient)) settings[key] = coefficient
        }
        return settings
    }, [leagueId, scoringKey])
    const lastSeason = useRef({ resourceKey, year: selectedSeason, lines: EMPTY_LINES })
    if (lastSeason.current.resourceKey !== resourceKey) lastSeason.current = { resourceKey, year: selectedSeason, lines: EMPTY_LINES }
    if (lines.value !== undefined) lastSeason.current = { resourceKey, year: selectedSeason, lines: lines.value }
    const displayedLines = lines.value ?? lastSeason.current.lines
    const displayedSeasonKey = lines.value !== undefined ? seasonKey : JSON.stringify([resourceKey, lastSeason.current.year])
    const summary = useMemo(() => summarizePlayerSeason(displayedLines, player.value?.nba_team ?? null, scoring), [displayedLines, player.value?.nba_team, scoring])
    const persistedSnapshot = useRef<string | null>(null)
    useEffect(() => {
        if (!canRead()) return
        if (lines.value !== undefined) seasonCache.entries.set(selectedSeason, lines.value)
        const snapshot: PlayerScreenCache = {
            today: todayET(), player: player.value, availableSeasons: seasons.value, selectedSeason,
            seasons: Array.from(seasonCache.entries.entries()).slice(-3), nextProjection: projection.value, transactions: history.value,
        }
        const serialized = JSON.stringify([resourceKey, snapshot])
        if (persistedSnapshot.current === serialized) return
        writePersistentCache(cacheKey, snapshot)
        persistedSnapshot.current = serialized
    }, [cacheKey, resourceKey, canRead, player.value, seasons.value, selectedSeason, lines.value, projection.value, history.value, seasonCache])
    const count = visibleGames.key === displayedSeasonKey ? visibleGames.count : GAME_LOG_PAGE
    const gameLog = useMemo(() => summary.games.slice(0, count), [summary.games, count])
    const loadMoreGames = useCallback(async () => {
        if (!lines.settled) return
        setVisibleGames(previous => ({ key: seasonKey, count: (previous.key === seasonKey ? previous.count : GAME_LOG_PAGE) + GAME_LOG_PAGE }))
    }, [seasonKey, lines.settled])
    const handleSeasonSelect = useCallback((year: number) => setSelection({ key: resourceKey, year }), [resourceKey])
    return {
        canRead, readEpoch, isCurrentRead, rosterRevision: refreshes.roster,
        initialSettled: player.settled && seasons.settled && lines.settled && scoringSettings.settled && projection.settled && history.settled,
        player: player.value ?? null, loading: !player.settled, playerError: player.error,
        availableSeasons, selectedSeason, handleSeasonSelect,
        seasonAverages: summary.averages, seasonLoading: !lines.settled, seasonError: lines.error ?? scoringSettings.error,
        includesLive: summary.includesLive, liveGame: summary.games.find(game => game.live && !game.didNotPlay) ?? null,
        gameLog, hasMoreGames: summary.games.length > count, loadMoreGames,
        fantasyPointsMap: summary.fantasyPointsMap, avgFantasyPoints: summary.avgFantasyPoints,
        nextProjection: projection.value ?? null, projectionError: projection.error, projectionSettled: projection.settled,
        transactions: history.value ?? EMPTY_TRANSACTIONS, transactionsError: history.error, transactionsSettled: history.settled,
    }
}
