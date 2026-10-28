import { cachedScreenView, readScreenView, subscribeScreenView } from '@/lib/cache/screen-cache'
import { screenScope } from '@/lib/cache/screen-scope'
import type { LineupView } from '@/lib/cache/view-types'
import { LineupControls } from '@/components/ui/LineupControls'
import { SectionBand } from '@/components/ui/SectionBand'
import { holdPwaUpdate } from '@/lib/pwa-update-guard'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { ScreenStatusScrollView as ScrollView, ScreenStatusOverlay, ScreenStatusProvider } from '@/components/ui/ScreenStatusOverlay'
import { DeferredContent } from '@/components/ui/DeferredContent'

import { DaySelector } from '@/components/DaySelector'


import { colors, componentTokens, controlSize, fontSize, fontWeight, layout, radii, spacing, textStyles, uiColors, tracking } from '@/constants/tokens'
import { useLeagueContext } from '@/contexts/league-context'
import { browserReadsAllowed } from '@/hooks/use-browser-read-activity'
import { useAuth } from '@/hooks/use-auth'
import { getGameDisplayState } from '@/lib/home-surface'
import { useLineupActions } from '@/hooks/use-lineup-actions'

import { leagueSnapshotRevision } from '@/lib/league-changes'
import { getErrorMessage } from '@/lib/shared/errors'
import { getLineupMoveTargetState, LineupContext, LineupPlayer, LineupSlot, WeekDay, type LineupMoveTargetState } from '@/lib/lineup'
import { setLineupOptimizerEnabled } from '@/lib/lineup/optimizerSettings'

import { endOfETDayUTC, todayET } from '@/lib/shared/dates'
import { invalidateSeasonCache } from '@/lib/shared/season'
import { invalidateWeekNumberCache } from '@/lib/shared/week'
import { readStoredAuthState } from '@/lib/supabase'
import { sessionGeneration } from '@/lib/session-cache-registry'
import { readLineupSnapshot, saveLineupSnapshot, discardLineupSnapshot, updateLineupOptimizerSnapshot, type LineupSnapshot } from '@/lib/lineup/snapshot'
import { showAlert } from '@/lib/alert'
import { useLocalSearchParams } from 'expo-router'
import { type ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    StyleSheet,
    Text,
    View,
} from 'react-native'
import { MotionPressable, MotionView } from '@/components/Motion'
import { Page, PageHeader, usePageMetrics } from '@/components/ui'
import { useGoBack } from '@/components/ui/useGoBack'

const TWO_COLUMN_MIN_WIDTH = 940

// Memoized row component that only re-renders when its props change
const StarterRow = memo(function StarterRow({
    slot,
    index,
    isSelected,
    liveTeams,
    startedTeams,
    teamMatchups,
    onPress,
    disabled,
    readOnly,
    targetState,
}: {
    slot: LineupSlot
    index: number
    isSelected: boolean
    liveTeams: Set<string>
    startedTeams: Set<string>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    onPress: () => void
    disabled: boolean
    readOnly: boolean
    targetState: LineupMoveTargetState
}) {
    const p = slot.player
    const isLocked = !!(p?.nbaTeam && startedTeams.has(p.nbaTeam))
    const isLive = !!(p?.nbaTeam && liveTeams.has(p.nbaTeam))
    const starterMatchup = p?.nbaTeam ? teamMatchups.get(p.nbaTeam) : undefined
    const starterMatchupLabel = p?.nbaTeam
        ? (starterMatchup ? `${starterMatchup.isHome ? 'vs' : '@'} ${starterMatchup.opponent}` : '· No game')
        : null

    return (
        <MotionPressable
            style={[
                styles.slotRow,
                index > 0 && styles.divider,
                isSelected && styles.selectedRow,
                targetState === 'valid' && styles.validTargetRow,
                targetState === 'invalid' && styles.invalidTargetRow,
            ]}
            onPress={onPress}
            disabled={disabled || isLocked || targetState === 'invalid'}
            disabledOpacity={readOnly ? 1 : undefined}
            accessibilityRole="button"
            accessibilityLabel={p ? `${slot.slotType} ${p.displayName}` : `Empty ${slot.slotType} slot`}
            accessibilityHint={targetState === 'valid' ? `Move here to use the ${slot.slotType} slot` : undefined}
            accessibilityState={{ selected: isSelected, disabled: disabled || isLocked || targetState === 'invalid' }}
        >
            <Text style={styles.slotLabel}>{slot.slotType}</Text>
            {p ? (
                <>
<PlayerRowContent name={p.displayName} nbaId={p.nbaId} team={p.nbaTeam} positions={p.eligiblePositions}
                        yearsExp={p.yearsExp} careerGames={p.careerGames} injuryStatus={p.injuryStatus} stats={starterMatchupLabel ?? undefined} />
                    <Text style={[styles.rowStatus, isLocked ? styles.lockedBadge : styles.moveBadge]}>
                        {isLocked ? isLive ? 'LIVE' : 'LOCK' : targetState === 'valid' ? 'MOVE' : ''}
                    </Text>
                </>
            ) : (
                <Text style={styles.emptySlot}>Empty</Text>
            )}
        </MotionPressable>
    )
})

// Memoized bench player row component
const BenchRow = memo(function BenchRow({
    player,
    index,
    isSelected,
    liveTeams,
    startedTeams,
    teamMatchups,
    onPress,
    disabled,
    readOnly,
    targetState,
}: {
    player: LineupPlayer
    index: number
    isSelected: boolean
    liveTeams: Set<string>
    startedTeams: Set<string>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    onPress: () => void
    disabled: boolean
    readOnly: boolean
    targetState: LineupMoveTargetState
}) {
    const isLocked = !!(player.nbaTeam && startedTeams.has(player.nbaTeam))
    const isLive = !!(player.nbaTeam && liveTeams.has(player.nbaTeam))
    const benchMatchup = player.nbaTeam ? teamMatchups.get(player.nbaTeam) : undefined
    const benchMatchupLabel = player.nbaTeam
        ? (benchMatchup ? `${benchMatchup.isHome ? 'vs' : '@'} ${benchMatchup.opponent}` : '· No game')
        : null

    return (
        <MotionPressable
            style={[
                styles.benchRow,
                index > 0 && styles.divider,
                isSelected && styles.selectedRow,
                targetState === 'valid' && styles.validTargetRow,
                targetState === 'invalid' && styles.invalidTargetRow,
            ]}
            onPress={onPress}
            disabled={disabled || isLocked || targetState === 'invalid'}
            disabledOpacity={readOnly ? 1 : undefined}
            accessibilityRole="button"
            accessibilityLabel={`Bench ${player.displayName}`}
            accessibilityHint={targetState === 'valid' ? 'Move here to place the selected player on the bench' : undefined}
            accessibilityState={{ selected: isSelected, disabled: disabled || isLocked || targetState === 'invalid' }}
        >
<PlayerRowContent name={player.displayName} nbaId={player.nbaId} team={player.nbaTeam} positions={player.eligiblePositions}
                        yearsExp={player.yearsExp} careerGames={player.careerGames} injuryStatus={player.injuryStatus} stats={benchMatchupLabel ?? undefined} />
                    <Text style={[styles.rowStatus, isLocked ? styles.lockedBadge : styles.moveBadge]}>
                {isLocked ? isLive ? 'LIVE' : 'LOCK' : targetState === 'valid' ? 'MOVE' : ''}
            </Text>
        </MotionPressable>
    )
})

function LineupFrame({ inline, children }: { inline: boolean; children: ReactNode }) {
    return inline ? <View accessibilityLabel="Your lineup">{children}</View> : <Page title="Lineup">{children}</Page>
}

function LineupBody({ inline, padX, twoColumn, children }: { inline: boolean; padX: number; twoColumn: boolean; children: ReactNode }) {
    const contentStyle = [styles.scroll, { paddingHorizontal: padX }, twoColumn && styles.scrollWide]
    return inline ? <View style={contentStyle}>{children}</View> : <ScrollView style={styles.scroller} contentContainerStyle={contentStyle}>{children}</ScrollView>
}

export function LineupEditor({ inline = false }: { inline?: boolean }) {
    const recoverLineup = useRef<(() => boolean) | null>(null)
    useEffect(() => holdPwaUpdate('lineup editor', () => recoverLineup.current?.() === true), [])
    const back = useGoBack('/roster')
    const { padX, usableWidth, compact: compactDays } = usePageMetrics()
    // Wide screens set starters and bench side by side, so a move never needs a scroll.
    const twoColumn = !inline && usableWidth >= TWO_COLUMN_MIN_WIDTH
    const { playerId: playerIdParam } = useLocalSearchParams<{ playerId?: string | string[] }>()
    const requestedPlayerId = Array.isArray(playerIdParam) ? playerIdParam[0] : playerIdParam
    const { user } = useAuth()
    const { current, currentLeague, online, membershipValidated, membershipError, refresh: refreshLeague } = useLeagueContext()
    const userId = user?.id
    const memberId = current?.id
    const leagueId = currentLeague?.id
    const leagueRevision = JSON.stringify(currentLeague)
    const [currentDay, setCurrentDay] = useState(todayET)
    const snapshotScope = useMemo(() => userId && memberId && leagueId
        ? { ownerId: userId, memberId, leagueId, day: currentDay } : null,
    [userId, memberId, leagueId, currentDay])

    const [ctx, setCtx] = useState<LineupContext | null>(null)
    const [weekDays, setWeekDays] = useState<WeekDay[]>([])
    // selectedDate is overwritten by load() with lineupCtx.today (ET) once
    // the lineup context loads. The initial value is read by useLiveStats
    // (which queries nba_games by ET-keyed game_date) before then — use
    // todayET so the very first poll/query lines up with the backend.
    const [selectedDate, setSelectedDate] = useState<string>(
        () => todayET(),
    )
    const [starters, setStarters] = useState<LineupSlot[]>([])
    const [dataDate, setDataDate] = useState(selectedDate)
    const [bench, setBench] = useState<LineupPlayer[]>([])
    const [benchSlots, setBenchSlots] = useState(0)
    const [reserves, setReserves] = useState<{ ir: LineupPlayer[]; taxi: LineupPlayer[] }>({ ir: [], taxi: [] })
    const [seasonOptimizerEnabled, setSeasonOptimizerEnabled] = useState(false)
    const [optimizerSaving, setOptimizerSaving] = useState(false)
    const [lineupLoading, setLineupLoading] = useState(true)
    const [lineupRefreshing, setLineupRefreshing] = useState(false)
    const [lineupError, setLineupError] = useState<string | null>(null)
    const lineupLoadSeqRef = useRef(0)
    const preselectedKeyRef = useRef<string | null>(null)
    const ownerKey = snapshotScope ? `${snapshotScope.ownerId}:${snapshotScope.memberId}:${snapshotScope.leagueId}:${snapshotScope.day}` : null
    const activeOwnerRef = useRef(ownerKey)
    if (activeOwnerRef.current !== ownerKey) {
        activeOwnerRef.current = ownerKey
        lineupLoadSeqRef.current += 1
    }
    const selectedDateRef = useRef(selectedDate)
    selectedDateRef.current = selectedDate
    const [savedSnapshot, setSavedSnapshot] = useState(true)
    const [contextAuthority, setContextAuthority] = useState(false)
    const loadPendingRef = useRef<{ key: string; requestId: number; promise: Promise<boolean> } | null>(null)
    const [dataOwnerKey, setDataOwnerKey] = useState(ownerKey)
    const dataOwnerRef = useRef(dataOwnerKey)
    dataOwnerRef.current = dataOwnerKey

    const [liveView, setLiveView] = useState<{ owner: string | null; value?: LineupView }>(() => ({ owner: ownerKey, value: snapshotScope ? cachedScreenView<LineupView>(screenScope('lineup', snapshotScope.leagueId, snapshotScope.memberId, { date: selectedDate }, snapshotScope.ownerId))?.value : undefined }))
    const liveData = liveView.owner === ownerKey && liveView.value?.date === selectedDate ? liveView.value : undefined
    const startedTeams = useMemo(() => new Set(liveData?.startedTeams ?? []), [liveData])
    const todaysGames = useMemo(() => liveData?.games ?? [], [liveData])
    const teamMatchups = useMemo(() => new Map(Object.entries(liveData?.teamMatchups ?? {})), [liveData])
    const freshness = !online ? 'offline' as const : liveData ? 'fresh' as const : 'refreshing' as const
    const { ready: gamesReady, liveTeams } = useMemo(() => getGameDisplayState(todaysGames, freshness), [todaysGames, freshness])

    const requestIsCurrent = useCallback((requestId: number, generation: number) =>
        activeOwnerRef.current === ownerKey && lineupLoadSeqRef.current === requestId && browserReadsAllowed()
        && currentDay === todayET() && generation === sessionGeneration() && readStoredAuthState().session?.user.id === userId,
    [ownerKey, userId, currentDay])

    const applySnapshot = useCallback((value: Pick<LineupSnapshot, 'context' | 'date' | 'days' | 'starters' | 'bench' | 'benchSlots' | 'ir' | 'taxi' | 'optimizerEnabled'>, saved: boolean) => {
        setDataOwnerKey(ownerKey)
        setCtx(value.context)
        setWeekDays(value.days)
        setSelectedDate(value.date)
        setDataDate(value.date)
        selectedDateRef.current = value.date
        setSeasonOptimizerEnabled(value.optimizerEnabled)
        setStarters(value.starters)
        setBench(value.bench)
        setBenchSlots(value.benchSlots ?? 0)
        setReserves({ ir: value.ir ?? [], taxi: value.taxi ?? [] })
        setSavedSnapshot(saved)
        if (saved) setContextAuthority(false)
    }, [ownerKey])

    const failedLoad = useCallback((error: unknown) => {
        setContextAuthority(false)
        console.error(error)
        const code = (error as { code?: string; status?: number })?.code
        const status = (error as { status?: number })?.status
        if (snapshotScope && (['42501', '28000', 'PGRST301', 'PGRST302', 'PGRST303', 'PGRST116'].includes(code ?? '')
            || status === 401 || status === 403 || status === 404)) {
            discardLineupSnapshot(snapshotScope)
            setCtx(null)
            setStarters([])
            setBench([])
        }
        setSavedSnapshot(true)
        setLineupError(getErrorMessage(error) ?? 'Could not load lineup.')
    }, [snapshotScope])

    const missingContextPending = !snapshotScope && !membershipValidated && !membershipError
    const missingContextError = snapshotScope ? null : membershipError?.message ?? null
    const lastReadRef = useRef<{ ownerKey: string; generation: number; date: string; at: number; leagueRevision: string; streamRevision: string | null } | null>(null)
    const load = useCallback((requestedDate?: string): Promise<boolean> => {
        if (!snapshotScope || !ownerKey) {
            setCtx(null); setStarters([]); setBench([]); setWeekDays([])
            setLineupLoading(missingContextPending)
            setLineupError(missingContextError)
            return Promise.resolve(false)
        }
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return Promise.resolve(false)
        const wanted = requestedDate ?? (dataOwnerRef.current === ownerKey ? selectedDateRef.current : currentDay)
        const pendingKey = `${ownerKey}:${sessionGeneration()}:${online}:${wanted}:${leagueRevision}`
        // Join a pending load only while it is still the newest request; a load that a later
        // request (such as going offline) superseded will discard its result.
        const joinable = loadPendingRef.current
        if (joinable?.key === pendingKey && joinable.requestId === lineupLoadSeqRef.current) return joinable.promise
        const requestId = ++lineupLoadSeqRef.current
        const generation = sessionGeneration()
        const cached = readLineupSnapshot(snapshotScope, wanted)
        if (cached) applySnapshot(cached, true)
        else if (dataOwnerRef.current !== ownerKey) {
            setCtx(null); setStarters([]); setBench([]); setWeekDays([])
        } else if (!online) {
            // Keep same-owner date controls, but never show another day's domain rows.
            setDataDate(''); setStarters([]); setBench([])
        }
        setLineupLoading(!cached)
        setLineupRefreshing(Boolean(cached && online))
        setSavedSnapshot(true)
        setContextAuthority(false)
        setLineupError(null)
        if (!online) {
            setLineupLoading(false)
            setLineupRefreshing(false)
            if (!cached) setLineupError('No saved lineup for this day. Connect to load it.')
            return Promise.resolve(false)
        }
        const task = (async () => {
            try {
                const lineup = await readScreenView<LineupView>(screenScope('lineup', snapshotScope.leagueId, snapshotScope.memberId, { date: wanted }, snapshotScope.ownerId))
                if (!requestIsCurrent(requestId, generation)) return false
                setLiveView({ owner: ownerKey, value: lineup })
                const lineupCtx = { seasonId: lineup.context.seasonId!, seasonYear: lineup.context.seasonYear, weekNumber: lineup.context.weekNumber ?? 1, today: lineup.context.today }
                const days = lineup.weekDays
                const date = lineup.date
                const optimizerEnabled = lineup.optimizer?.enabled ?? false
                if (!requestIsCurrent(requestId, generation)) return false
                const value = { context: lineupCtx, date, days, starters: lineup.starters, bench: lineup.bench, benchSlots: lineup.benchSlots, ir: lineup.ir, taxi: lineup.taxi, optimizerEnabled }
                saveLineupSnapshot(snapshotScope, generation, value)
                applySnapshot(value, false)
                setContextAuthority(true)
                lastReadRef.current = { ownerKey, generation, date, at: Date.now(), leagueRevision, streamRevision: leagueSnapshotRevision(snapshotScope.leagueId, 'lineup') }
                return true
            } catch (error) {
                if (requestIsCurrent(requestId, generation)) {
                    lastReadRef.current = null
                    failedLoad(error)
                }
                return false
            } finally {
                if (requestIsCurrent(requestId, generation)) { setLineupLoading(false); setLineupRefreshing(false) }
            }
        })()
        const pending = { key: pendingKey, requestId, promise: task }
        loadPendingRef.current = pending
        void task.finally(() => {
            if (loadPendingRef.current !== pending) return
            loadPendingRef.current = null
            const lastRead = lastReadRef.current
            if (lastRead?.ownerKey === ownerKey && lastRead.generation === generation && lastRead.at === 0
                && requestIsCurrent(requestId, generation)) void load(selectedDateRef.current)
        })
        return task
    }, [snapshotScope, ownerKey, online, currentDay, applySnapshot, requestIsCurrent, failedLoad, leagueRevision, missingContextPending, missingContextError])

    useEffect(() => {
        if (!snapshotScope) return
        const scope = screenScope('lineup', snapshotScope.leagueId, snapshotScope.memberId, { date: selectedDate }, snapshotScope.ownerId)
        return subscribeScreenView(scope, () => { if (cachedScreenView(scope)?.dirty) { lastReadRef.current = null; void load() } })
    }, [snapshotScope, selectedDate, load])

    const previousOnlineRef = useRef(online)
    const contextDayRef = useRef(currentDay)
    const leagueSnapshotRef = useRef(leagueRevision)
    useEffect(() => {
        if ((online && !previousOnlineRef.current) || contextDayRef.current !== currentDay || leagueSnapshotRef.current !== leagueRevision) {
            invalidateSeasonCache(leagueId)
            invalidateWeekNumberCache()
        }
        previousOnlineRef.current = online
        contextDayRef.current = currentDay
        leagueSnapshotRef.current = leagueRevision
        void load()
    }, [load, online, currentDay, leagueId, leagueRevision])
    useEffect(() => () => { lineupLoadSeqRef.current += 1 }, [])
    useEffect(() => {
        const refresh = () => {
            if (!browserReadsAllowed()) {
                if (loadPendingRef.current) {
                    lineupLoadSeqRef.current += 1
                    loadPendingRef.current = null
                    lastReadRef.current = null
                    setContextAuthority(false)
                    setSavedSnapshot(true)
                    setLineupLoading(false)
                    setLineupRefreshing(false)
                }
                return
            }
            const day = todayET()
            if (day !== currentDay) setCurrentDay(day)
            else {
                const lastRead = lastReadRef.current
                if (lastRead?.ownerKey === ownerKey && lastRead.generation === sessionGeneration()
                    && lastRead.leagueRevision === leagueRevision && lastRead.date === selectedDateRef.current
                    && lastRead.streamRevision === (leagueId ? leagueSnapshotRevision(leagueId, 'lineup') : null) && Date.now() - lastRead.at < 300_000) return
                invalidateSeasonCache(leagueId)
                invalidateWeekNumberCache()
                void load()
            }
        }
        const timer = setTimeout(() => setCurrentDay(todayET()), Math.max(1, Date.parse(endOfETDayUTC(currentDay)) - Date.now() + 1))
        window.addEventListener('focus', refresh)
        window.addEventListener('pageshow', refresh)
        window.addEventListener('offline', refresh)
        document.addEventListener('visibilitychange', refresh)
        return () => {
            clearTimeout(timer)
            window.removeEventListener('focus', refresh)
            window.removeEventListener('pageshow', refresh)
            window.removeEventListener('offline', refresh)
            document.removeEventListener('visibilitychange', refresh)
        }
    }, [currentDay, load, leagueId, ownerKey, leagueRevision])

    const ownsLineup = dataOwnerKey === ownerKey
    const visibleCtx = ownsLineup ? ctx : null
    const matchingDay = dataDate === selectedDate
    const visibleStarters = useMemo(() => ownsLineup && matchingDay ? starters : [], [ownsLineup, matchingDay, starters])
    const visibleBench = useMemo(() => ownsLineup && matchingDay ? bench : [], [bench, matchingDay, ownsLineup])
    const readOnly = !ownsLineup || !matchingDay || (online && (!contextAuthority || savedSnapshot || lineupLoading || lineupRefreshing || Boolean(lineupError)))
    const savedMatchups = useMemo(() => {
        const teams = weekDays.find((d) => d.date === selectedDate)?.playingTeams ?? []
        const result = new Map<string, { opponent: string; isHome: boolean }>()
        for (let i = 0; i + 1 < teams.length; i += 2) {
            result.set(teams[i], { opponent: teams[i + 1], isHome: true })
            result.set(teams[i + 1], { opponent: teams[i], isHome: false })
        }
        return result
    }, [weekDays, selectedDate])
    const displayedMatchups = readOnly ? savedMatchups : teamMatchups
    const actionOwner = current && visibleCtx && currentLeague ? {
        memberId: current.id,
        leagueId: currentLeague.id,
        seasonId: visibleCtx.seasonId,
        weekNumber: visibleCtx.weekNumber,
        seasonYear: visibleCtx.seasonYear,
    } : null
    const actionContext = readOnly ? null : actionOwner
    const optimizerOwner = actionOwner ? `${ownerKey}:${actionOwner.seasonId}` : null
    const optimizerOwnerRef = useRef(optimizerOwner)
    const optimizerRequestRef = useRef(0)
    if (optimizerOwnerRef.current !== optimizerOwner) {
        optimizerOwnerRef.current = optimizerOwner
        optimizerRequestRef.current += 1
    }
    useEffect(() => { setOptimizerSaving(false) }, [optimizerOwner])
    useEffect(() => () => { optimizerRequestRef.current += 1 }, [])
    const optimizerRequestIsCurrent = (requestId: number, generation: number) =>
        optimizerRequestRef.current === requestId && optimizerOwnerRef.current === optimizerOwner
        && generation === sessionGeneration() && readStoredAuthState().session?.user.id === userId
    const lineupForActions = useMemo(
        () => visibleCtx ? { starters: visibleStarters, bench: visibleBench } : null,
        [visibleBench, visibleCtx, visibleStarters],
    )
    const reloadLineupForActions = useCallback(async (date: string) => {
        await load(date)
    }, [load])


    const {
        canRecover,
        selected,
        setSelected,
        saving,
        autoSetting,
        autoSetDisabled,
        handleTap,
        doAutoSet,
    } = useLineupActions({
        actionContext,
        actionOwner,
        myLineup: lineupForActions,
        league: currentLeague,
        selectedDate,
        startedTeams,
        reloadLineup: reloadLineupForActions,
    })
    recoverLineup.current = canRecover

    const preselectedKey = requestedPlayerId ? `${ownerKey}:${selectedDate}:${requestedPlayerId}` : null
    const preselectionPending = Boolean(preselectedKey && preselectedKeyRef.current !== preselectedKey && !readOnly && lineupForActions)
    const requestedStarterIndex = preselectionPending ? visibleStarters.findIndex((slot) => slot.player?.playerId === requestedPlayerId) : -1
    const requestedBenchIndex = preselectionPending ? visibleBench.findIndex((player) => player.playerId === requestedPlayerId) : -1
    const displayedSelection = requestedStarterIndex >= 0
        ? { kind: 'starter' as const, index: requestedStarterIndex }
        : requestedBenchIndex >= 0
            ? { kind: 'bench' as const, index: requestedBenchIndex }
            : selected

    useEffect(() => {
        if (!requestedPlayerId || readOnly || lineupLoading || lineupRefreshing || !lineupForActions) return
        const preselectedKey = `${ownerKey}:${selectedDate}:${requestedPlayerId}`
        if (preselectedKeyRef.current === preselectedKey) return
        preselectedKeyRef.current = preselectedKey
        const starterIndex = visibleStarters.findIndex((slot) => slot.player?.playerId === requestedPlayerId)
        if (starterIndex >= 0) {
            setSelected({ kind: 'starter', index: starterIndex })
            return
        }
        const benchIndex = visibleBench.findIndex((player) => player.playerId === requestedPlayerId)
        if (benchIndex >= 0) setSelected({ kind: 'bench', index: benchIndex })
    }, [lineupForActions, lineupLoading, lineupRefreshing, ownerKey, readOnly, requestedPlayerId, selectedDate, setSelected, visibleBench, visibleStarters])

    const targetState = (to: { kind: 'starter' | 'bench'; index: number }) =>
        !readOnly && lineupForActions && currentLeague
            ? getLineupMoveTargetState({
                  lineup: lineupForActions,
                  league: currentLeague,
                  startedTeams,
                  from: displayedSelection,
                  to,
              })
            : null

    async function handleDaySelect(date: string) {
        setSelectedDate(date)
        selectedDateRef.current = date
        setDataDate('')
        setStarters([])
        setBench([])
        setContextAuthority(false)
        setSavedSnapshot(true)
        setSelected(null)
        await load(date)
    }

    async function handleEnableSeasonOptimizer() {
        if (!actionContext) return
        const requestId = ++optimizerRequestRef.current
        const generation = sessionGeneration()
        setOptimizerSaving(true)
        try {
            await setLineupOptimizerEnabled(
                actionContext.memberId,
                actionContext.leagueId,
                actionContext.seasonId,
                true,
            )
            if (optimizerRequestIsCurrent(requestId, generation)) {
                if (snapshotScope) updateLineupOptimizerSnapshot(snapshotScope, generation, actionContext.seasonId, true)
                setSeasonOptimizerEnabled(true)
            }
        } catch (e) {
            if (optimizerRequestIsCurrent(requestId, generation)) showAlert('Auto-set daily failed', getErrorMessage(e))
        } finally {
            if (optimizerRequestIsCurrent(requestId, generation)) setOptimizerSaving(false)
        }
    }

    async function handleDisableSeasonOptimizer() {
        if (!actionContext) return
        const requestId = ++optimizerRequestRef.current
        const generation = sessionGeneration()
        setOptimizerSaving(true)
        try {
            await setLineupOptimizerEnabled(
                actionContext.memberId,
                actionContext.leagueId,
                actionContext.seasonId,
                false,
            )
            if (optimizerRequestIsCurrent(requestId, generation)) {
                if (snapshotScope) updateLineupOptimizerSnapshot(snapshotScope, generation, actionContext.seasonId, false)
                setSeasonOptimizerEnabled(false)
            }
        } catch (e) {
            if (optimizerRequestIsCurrent(requestId, generation)) showAlert('Auto-set daily failed', getErrorMessage(e))
        } finally {
            if (optimizerRequestIsCurrent(requestId, generation)) setOptimizerSaving(false)
        }
    }

    if (!visibleCtx) {
        const emptyMessage = lineupLoading
            ? ''
            : lineupError
              ? 'Could not load lineup.'
              : !snapshotScope && membershipValidated ? 'No active league.' : 'No active lineup yet.'
        return (
            <DeferredContent ready={!lineupLoading} fallback={<LineupFrame inline={inline}>{!inline ? <PageHeader compact title="Lineup" onBack={() => back()} backLabel="Close lineup" /> : null}</LineupFrame>}>
            <LineupFrame inline={inline}>
                {!inline ? <PageHeader compact title="Lineup" onBack={() => back()} backLabel="Close lineup" /> : null}
                <View style={[styles.empty, { minHeight: 320 }]} aria-busy={lineupLoading} accessibilityState={{ busy: lineupLoading }}>
                    <Text style={styles.emptyText}>{emptyMessage}</Text>
                    {lineupError ? <Text style={styles.emptySubtext}>{lineupError}</Text> : null}
                    {lineupError ? (
                        <MotionPressable
                            style={styles.retryButton}
                            onPress={() => { if (!snapshotScope) void refreshLeague(); else void load() }}
                            accessibilityRole="button"
                            accessibilityLabel="Retry lineup load"
                        >
                            <Text style={styles.retryButtonText}>Try again</Text>
                        </MotionPressable>
                    ) : null}
                </View>
            </LineupFrame>
            </DeferredContent>
        )
    }

    const rosterEmpty = visibleStarters.every((s) => !s.player) && visibleBench.length === 0

    return (
        <DeferredContent ready={(!lineupLoading && matchingDay && gamesReady && (!preselectedKey || preselectedKeyRef.current === preselectedKey || !lineupRefreshing)) || Boolean(lineupError)}>
        <LineupFrame inline={inline}>
            {!inline ? <PageHeader
                title={`Week ${visibleCtx.weekNumber} lineup`}
                onBack={() => back()}
                backLabel="Close lineup"
                compact
            /> : null}

            <View style={{ marginHorizontal: padX }} accessibilityLabel="Auto lineup">
                <LineupControls
                    actions={[
                        { title: 'Today', label: 'Auto-set today', onPress: () => { void doAutoSet(todayET()) } },
                        { title: 'This week', label: 'Auto-set this week', onPress: () => { void doAutoSet(null) } },
                        { title: 'Rest of season', label: 'Auto-set rest of season', onPress: () => { void doAutoSet(null, true) } },
                    ]}
                    disabled={readOnly || autoSetDisabled || autoSetting || saving || rosterEmpty}
                    automatic={seasonOptimizerEnabled}
                    automaticDisabled={readOnly || optimizerSaving}
                    onAutomaticChange={(enabled) => { void (enabled ? handleEnableSeasonOptimizer() : handleDisableSeasonOptimizer()) }}
                />
            </View>

            <Text style={[textStyles.meta, { paddingHorizontal: padX, paddingVertical: spacing.sm }]}>
                Tap a player, then a slot or another player to swap. Locked players stay in place.
            </Text>

            {/* Day selector */}
            {weekDays.length > 0 && (
                <DaySelector days={weekDays} selectedDate={selectedDate} onSelect={handleDaySelect} compact={compactDays} disabled={autoSetting} />
            )}

            {lineupError && online ? (
                <View style={styles.errorBanner}>
                    <Text style={styles.errorBannerText}>{lineupError}</Text>
                    <MotionPressable
                        style={styles.errorRetryButton}
                        onPress={() => { void load(selectedDate) }}
                        accessibilityRole="button"
                        accessibilityLabel="Retry selected lineup day"
                    >
                        <Text style={styles.errorRetryButtonText}>Retry</Text>
                    </MotionPressable>
                </View>
            ) : null}

            <LineupBody inline={inline} padX={padX} twoColumn={twoColumn}>
                {rosterEmpty && matchingDay ? (
                    <View style={styles.preDraftHint}>
                        <Text style={styles.preDraftHintText}>
                            No players yet — your roster fills as you draft. Draft players to set your Week {visibleCtx.weekNumber} lineup.
                        </Text>
                    </View>
                ) : null}
                <View style={[styles.columns, twoColumn && styles.columnsWide]}>
                {visibleStarters.length > 0 ? (
                <View style={[styles.column, twoColumn && styles.columnWide]}>
                {/* Starters */}
                <SectionBand variant="plain" label="Starters" style={styles.firstSectionLabel} />
                <MotionView style={styles.card} preset="rise">
                    {visibleStarters.map((slot, i) => (
                        <StarterRow
                            key={`starter-${i}`}
                            slot={slot}
                            index={i}
                            isSelected={displayedSelection?.kind === 'starter' && displayedSelection.index === i}
                            liveTeams={liveTeams}
                            startedTeams={startedTeams}
                            teamMatchups={displayedMatchups}
                            onPress={() => handleTap({ kind: 'starter', index: i })}
                            disabled={readOnly || autoSetting || saving || lineupRefreshing || lineupLoading}
                            readOnly={readOnly}
                            targetState={targetState({ kind: 'starter', index: i })}
                        />
                    ))}
                </MotionView>
                </View>

                ) : null}
                {matchingDay && Math.max(benchSlots, visibleBench.length) > 0 ? (
                <View style={[styles.column, twoColumn && styles.columnWide]}>
                <SectionBand variant="plain" label="Bench" />
                <MotionView style={styles.card} preset="rise" delay={90}>
                    {visibleBench.map((player, i) => (
                        <BenchRow
                            key={player.playerId}
                            player={player}
                            index={i}
                            isSelected={displayedSelection?.kind === 'bench' && displayedSelection.index === i}
                            liveTeams={liveTeams}
                            startedTeams={startedTeams}
                            teamMatchups={displayedMatchups}
                            onPress={() => handleTap({ kind: 'bench', index: i })}
                            disabled={readOnly || autoSetting || saving || lineupRefreshing || lineupLoading}
                            readOnly={readOnly}
                            targetState={targetState({ kind: 'bench', index: i })}
                        />
                    ))}
                    {Array.from({ length: Math.max(0, benchSlots - visibleBench.length) }, (_, i) => {
                        const index = visibleBench.length + i
                        const state = targetState({ kind: 'bench', index })
                        const disabled = readOnly || autoSetting || saving || lineupRefreshing || lineupLoading || state === 'invalid'
                        return (
                            <MotionPressable
                                key={`empty-${i}`}
                                style={[styles.benchRow, index > 0 && styles.divider, state === 'valid' && styles.validTargetRow]}
                                onPress={() => handleTap({ kind: 'bench', index })}
                                disabled={disabled}
                                disabledOpacity={readOnly ? 1 : undefined}
                                accessibilityRole="button"
                                accessibilityLabel="Empty bench slot"
                                accessibilityHint={state === 'valid' ? 'Move the selected player to the bench' : undefined}
                                accessibilityState={{ disabled }}
                            >
                                <Text style={styles.benchEmpty}>Empty bench slot</Text>
                            </MotionPressable>
                        )
                    })}
                </MotionView>
                </View>
                ) : null}
                </View>
                {matchingDay && ownsLineup ? ([
                    { label: 'IR', players: reserves.ir, count: currentLeague?.ir_slots ?? 0 },
                    { label: 'Taxi', players: reserves.taxi, count: currentLeague?.taxi_slots ?? 0 },
                ].map(({ label, players, count }) => Math.max(count, players.length) > 0 ? (
                    <View key={label}>
                        <SectionBand variant="plain" label={label} />
                        <View style={styles.card}>
                            {Array.from({ length: Math.max(count, players.length) }, (_, index) => {
                                const player = players[index]
                                return (
                                    <View key={player?.playerId ?? `empty-${index}`}
                                        style={[styles.slotRow, index > 0 && styles.divider]}
                                        accessibilityLabel={player ? `${label} ${player.displayName}` : `Empty ${label.toLowerCase()} slot`}>
                                        <Text style={styles.slotLabel}>{label}</Text>
                                        {player ? <PlayerRowContent name={player.displayName} nbaId={player.nbaId} team={player.nbaTeam}
                                            positions={player.eligiblePositions} yearsExp={player.yearsExp} careerGames={player.careerGames}
                                            injuryStatus={player.injuryStatus} /> : <Text style={styles.emptySlot}>Empty {label.toLowerCase()} slot</Text>}
                                    </View>
                                )
                            })}
                        </View>
                    </View>
                ) : null)) : null}
            </LineupBody>
            <ScreenStatusOverlay>
                {readOnly && ((!matchingDay && !lineupLoading) || !online || lineupError) ? (
                    <View style={styles.statusBanner}>
                        <Text style={styles.statusBannerText}>{!matchingDay ? 'Lineup unavailable for this day' : !online ? 'Saved lineup · Offline · Changes stay pending' : 'Saved lineup · Refresh failed · Read only'}</Text>
                    </View>
                ) : null}
            </ScreenStatusOverlay>

        </LineupFrame>
        </DeferredContent>
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

const styles = StyleSheet.create({
    preDraftHint: {
        padding: spacing.lg,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primaryLight,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
    },
    preDraftHintText: { ...textStyles.body, color: colors.primaryDark, fontWeight: fontWeight.medium },

    statusBanner: {
        backgroundColor: colors.primaryLight,
        borderBottomWidth: 1,
        borderBottomColor: colors.primaryBorder,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
    },
    statusBannerText: { fontSize: fontSize.sm, color: colors.primaryDark, fontWeight: fontWeight.medium },
    errorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        backgroundColor: colors.dangerLight,
        borderBottomWidth: 1,
        borderBottomColor: colors.dangerLight,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
    },
    errorBannerText: { flex: 1, fontSize: fontSize.sm, color: colors.dangerDark, fontWeight: fontWeight.medium },
    errorRetryButton: {
        minHeight: controlSize.minTouch,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgScreen,
        alignItems: 'center',
        justifyContent: 'center',
    },
    errorRetryButtonText: { fontSize: fontSize.sm, color: colors.dangerDark, fontWeight: fontWeight.bold },

    scroller: { flex: 1, minHeight: 0 },
    scroll: { paddingTop: spacing.none, paddingBottom: spacing.lg, gap: spacing.md, width: '100%', maxWidth: layout.lineupMaxWidth, alignSelf: 'center' },
    scrollWide: { maxWidth: 2 * layout.lineupMaxWidth },
    columns: { gap: spacing.md },
    columnsWide: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing['3xl'] },
    // Only flex side by side; in one column a flex child would shrink inside the scroll view.
    column: { minWidth: 0 },
    columnWide: { flex: 1 },

    firstSectionLabel: { marginBottom: spacing.none },

    card: {
        backgroundColor: colors.bgCard,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        marginBottom: spacing.lg,
        overflow: 'hidden',
    },

    slotRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: componentTokens.playerRow.standard.paddingVertical,
        paddingHorizontal: spacing.lg,
        gap: componentTokens.playerRow.standard.gap,
        minHeight: componentTokens.playerRow.lineupHeight,
    },
    benchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: componentTokens.playerRow.standard.paddingVertical,
        paddingHorizontal: spacing.lg,
        gap: componentTokens.playerRow.standard.gap,
        minHeight: componentTokens.playerRow.lineupHeight,
    },
    divider: { borderTopWidth: 1, borderTopColor: colors.separator },
    selectedRow: { backgroundColor: colors.primaryLight },
    validTargetRow: { backgroundColor: colors.successLight },
    invalidTargetRow: { opacity: 0.38 },

    slotLabel: {
        width: 36,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        color: colors.primaryDark,
    },

    playerInfo: { flex: 1, minWidth: 0, gap: spacing.xxs },
    playerName: { ...textStyles.rowTitle },
    playerMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    playerMeta: { ...textStyles.meta, flexShrink: 1 },
    rowStatus: { width: controlSize.minTouch, textAlign: 'right' },

    emptySlot: { ...textStyles.body, color: colors.textMuted, fontStyle: 'italic' },
    lockedBadge: {
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.bold,
        color: uiColors.successTextLive,
    },
    moveBadge: {
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.extrabold,
        color: colors.successDark,
        letterSpacing: tracking.label,
    },
    benchEmpty: { fontSize: fontSize.sm, color: colors.textPlaceholder, fontStyle: 'italic' },

    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
    emptyText: { fontSize: fontSize.md, color: colors.textPlaceholder },
    emptySubtext: {
        maxWidth: 320,
        marginTop: spacing.sm,
        ...textStyles.meta,
        textAlign: 'center',
    },
    retryButton: {
        minHeight: controlSize.minTouch,
        marginTop: spacing.lg,
        paddingHorizontal: spacing.xl,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    retryButtonText: { fontSize: fontSize.sm, color: colors.textWhite, fontWeight: fontWeight.bold },
})

export default function LineupScreenWithStatus() {
    return <ScreenStatusProvider><LineupEditor /></ScreenStatusProvider>
}
