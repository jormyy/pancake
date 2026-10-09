import { AutoSetModal } from '@/components/AutoSetModal'
import { Avatar } from '@/components/Avatar'
import { DaySelector } from '@/components/DaySelector'
import { PosTag } from '@/components/PosTag'
import { InjuryBadge } from '@/components/Badge'
import { colors, fontSize, fontWeight, layout, radii, spacing, textStyles, uiColors } from '@/constants/tokens'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { useLineupActions } from '@/hooks/use-lineup-actions'
import { useLiveStats } from '@/hooks/use-live-stats'
import { getErrorMessage } from '@/lib/shared/errors'
import {
    clampDateToWeek,
    getLineupContext,
    getLineupMoveTargetState,
    getWeekDays,
    getWeeklyLineup,
    LineupContext,
    LineupPlayer,
    LineupSlot,
    WeekDay,
    type LineupMoveTargetState,
} from '@/lib/lineup'
import { getLineupOptimizerEnabled, setLineupOptimizerEnabled } from '@/lib/lineup/optimizerSettings'
import { playerHeadshotUrl } from '@/lib/format'
import {
    debounceRealtimeRefresh,
    disposeTableChangeSubscription,
    reportRealtimeCleanup,
    subscribeToTableChanges,
} from '@/lib/realtime'
import { endOfETDayUTC, todayET } from '@/lib/shared/dates'
import { invalidateSeasonCache } from '@/lib/shared/season'
import { invalidateWeekNumberCache } from '@/lib/shared/week'
import { readStoredAuthState } from '@/lib/supabase'
import { sessionGeneration } from '@/lib/session-cache-registry'
import { readLineupSnapshot, saveLineupSnapshot, discardLineupSnapshot, type LineupSnapshot } from '@/lib/lineup/snapshot'
import { showAlert } from '@/lib/alert'
import { useLocalSearchParams } from 'expo-router'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native'
import { MotionPressable, MotionView } from '@/components/Motion'
import { Button, Page, PageHeader, usePageMetrics } from '@/components/ui'
import { useGoBack } from '@/components/ui/useGoBack'

const TWO_COLUMN_MIN_WIDTH = 940

// Memoized row component that only re-renders when its props change
const StarterRow = memo(function StarterRow({
    slot,
    index,
    isSelected,
    liveTeamsRef,
    teamMatchups,
    onPress,
    disabled,
    readOnly,
    targetState,
}: {
    slot: LineupSlot
    index: number
    isSelected: boolean
    liveTeamsRef: React.RefObject<Set<string>>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    onPress: () => void
    disabled: boolean
    readOnly: boolean
    targetState: LineupMoveTargetState
}) {
    const p = slot.player
    const liveTeams = liveTeamsRef.current
    const isLocked = !!(p?.nbaTeam && liveTeams.has(p.nbaTeam))
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
            disabled={disabled || targetState === 'invalid'}
            disabledOpacity={readOnly ? 1 : undefined}
            accessibilityRole="button"
            accessibilityLabel={p ? `${slot.slotType} ${p.displayName}` : `Empty ${slot.slotType} slot`}
            accessibilityHint={targetState === 'valid' ? `Move here to use the ${slot.slotType} slot` : undefined}
            accessibilityState={{ selected: isSelected, disabled: disabled || targetState === 'invalid' }}
            pressedScale={0.985}
        >
            <Text style={styles.slotLabel}>{slot.slotType}</Text>
            {p ? (
                <>
                    <Avatar
                        name={p.displayName}
                        color={colors.bgMuted}
                        size={36}
                        uri={playerHeadshotUrl(p.nbaId)}
                    />
                    <View style={styles.playerInfo}>
                        <Text style={styles.playerName}>{p.displayName}</Text>
                        <View style={styles.playerMetaRow}>
                            <InjuryBadge status={p.injuryStatus} />
                            {p.eligiblePositions.map((pos) => <PosTag key={pos} position={pos} />)}
                            {starterMatchupLabel !== null && (
                                <Text style={styles.playerMeta}>{p.nbaTeam} {starterMatchupLabel}</Text>
                            )}
                        </View>
                    </View>
                    {isLocked && (
                        <Text style={styles.lockedBadge}>LIVE</Text>
                    )}
                    {targetState === 'valid' && <Text style={styles.moveBadge}>MOVE</Text>}
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
    liveTeamsRef,
    teamMatchups,
    onPress,
    disabled,
    readOnly,
    targetState,
}: {
    player: LineupPlayer
    index: number
    isSelected: boolean
    liveTeamsRef: React.RefObject<Set<string>>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    onPress: () => void
    disabled: boolean
    readOnly: boolean
    targetState: LineupMoveTargetState
}) {
    const liveTeams = liveTeamsRef.current
    const isLocked = !!(player.nbaTeam && liveTeams.has(player.nbaTeam))
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
            disabled={disabled || targetState === 'invalid'}
            disabledOpacity={readOnly ? 1 : undefined}
            accessibilityRole="button"
            accessibilityLabel={`Bench ${player.displayName}`}
            accessibilityHint={targetState === 'valid' ? 'Move here to place the selected player on the bench' : undefined}
            accessibilityState={{ selected: isSelected, disabled: disabled || targetState === 'invalid' }}
            pressedScale={0.985}
        >
            <Avatar
                name={player.displayName}
                color={colors.bgMuted}
                size={36}
                uri={playerHeadshotUrl(player.nbaId)}
            />
            <View style={styles.playerInfo}>
                <Text style={styles.playerName}>{player.displayName}</Text>
                <View style={styles.playerMetaRow}>
                    <InjuryBadge status={player.injuryStatus} />
                    {player.eligiblePositions.map((pos) => <PosTag key={pos} position={pos} />)}
                    {benchMatchupLabel !== null && (
                        <Text style={styles.playerMeta}>{player.nbaTeam} {benchMatchupLabel}</Text>
                    )}
                </View>
            </View>
            {isLocked && (
                <Text style={styles.lockedBadge}>LIVE</Text>
            )}
            {targetState === 'valid' && <Text style={styles.moveBadge}>MOVE</Text>}
        </MotionPressable>
    )
})

export default function LineupScreen() {
    const back = useGoBack('/roster')
    const { padX, usableWidth, compact: compactDays } = usePageMetrics()
    // Wide screens set starters and bench side by side, so a move never needs a scroll.
    const twoColumn = usableWidth >= TWO_COLUMN_MIN_WIDTH
    const { playerId: playerIdParam } = useLocalSearchParams<{ playerId?: string | string[] }>()
    const requestedPlayerId = Array.isArray(playerIdParam) ? playerIdParam[0] : playerIdParam
    const { user } = useAuth()
    const { current, currentLeague, online } = useLeagueContext()
    const userId = user?.id
    const memberId = current?.id
    const leagueId = currentLeague?.id
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
    const [seasonOptimizerEnabled, setSeasonOptimizerEnabled] = useState(false)
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
    const loadPendingRef = useRef<{ key: string; promise: Promise<void> } | null>(null)
    const [dataOwnerKey, setDataOwnerKey] = useState(ownerKey)

    const { startedTeams, liveTeams, teamMatchups } = useLiveStats(selectedDate)
    // Wrap in a ref so memoized row components read the latest value without re-rendering on poll updates
    const liveTeamsRef = useRef(liveTeams)
    liveTeamsRef.current = online && contextAuthority && !savedSnapshot ? liveTeams : new Set()

    const requestIsCurrent = useCallback((requestId: number, generation: number) =>
        activeOwnerRef.current === ownerKey && lineupLoadSeqRef.current === requestId
        && currentDay === todayET() && generation === sessionGeneration() && readStoredAuthState().session?.user.id === userId,
    [ownerKey, userId, currentDay])

    const applySnapshot = useCallback((value: Pick<LineupSnapshot, 'context' | 'date' | 'days' | 'starters' | 'bench' | 'optimizerEnabled'>, saved: boolean) => {
        setDataOwnerKey(ownerKey)
        setCtx(value.context)
        setWeekDays(value.days)
        setSelectedDate(value.date)
        setDataDate(value.date)
        selectedDateRef.current = value.date
        setSeasonOptimizerEnabled(value.optimizerEnabled)
        setStarters(value.starters)
        setBench(value.bench)
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

    const load = useCallback((requestedDate?: string): Promise<void> => {
        if (!snapshotScope || !ownerKey) {
            setCtx(null); setStarters([]); setBench([]); setWeekDays([]); setLineupLoading(false)
            return Promise.resolve()
        }
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return Promise.resolve()
        const wanted = requestedDate ?? (dataOwnerKey === ownerKey ? selectedDateRef.current : currentDay)
        const pendingKey = `${ownerKey}:${sessionGeneration()}:${online}:${wanted}`
        if (loadPendingRef.current?.key === pendingKey) return loadPendingRef.current.promise
        const requestId = ++lineupLoadSeqRef.current
        const generation = sessionGeneration()
        const cached = readLineupSnapshot(snapshotScope, wanted)
        if (cached) applySnapshot(cached, true)
        else if (dataOwnerKey !== ownerKey) {
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
            return Promise.resolve()
        }
        const task = (async () => {
            try {
                const lineupCtx = await getLineupContext(snapshotScope.leagueId, { memberId: snapshotScope.memberId, userId: snapshotScope.ownerId })
                if (!requestIsCurrent(requestId, generation)) return
                if (!lineupCtx) {
                    discardLineupSnapshot(snapshotScope)
                    setCtx(null); setStarters([]); setBench([]); setWeekDays([])
                    return
                }
                if (cached && cached.context.seasonId !== lineupCtx.seasonId) {
                    discardLineupSnapshot(snapshotScope)
                    setCtx(null); setStarters([]); setBench([])
                }
                const days = await getWeekDays(lineupCtx.weekNumber, lineupCtx.seasonYear)
                if (!requestIsCurrent(requestId, generation)) return
                const date = clampDateToWeek(wanted, days)
                const optimizerEnabled = await getLineupOptimizerEnabled(snapshotScope.memberId, snapshotScope.leagueId, lineupCtx.seasonId)
                if (!requestIsCurrent(requestId, generation)) return
                const lineup = await getWeeklyLineup(snapshotScope.memberId, snapshotScope.leagueId, lineupCtx.seasonId, lineupCtx.weekNumber, date)
                if (!requestIsCurrent(requestId, generation)) return
                const value = { context: lineupCtx, date, days, starters: lineup.starters, bench: lineup.bench, optimizerEnabled }
                saveLineupSnapshot(snapshotScope, generation, value)
                applySnapshot(value, false)
                setContextAuthority(true)
            } catch (error) {
                if (requestIsCurrent(requestId, generation)) failedLoad(error)
            } finally {
                if (requestIsCurrent(requestId, generation)) { setLineupLoading(false); setLineupRefreshing(false) }
            }
        })()
        const pending = { key: pendingKey, promise: task }
        loadPendingRef.current = pending
        void task.finally(() => { if (loadPendingRef.current === pending) loadPendingRef.current = null })
        return task
    }, [snapshotScope, ownerKey, online, dataOwnerKey, currentDay, applySnapshot, requestIsCurrent, failedLoad])

    const previousOnlineRef = useRef(online)
    const contextDayRef = useRef(currentDay)
    useEffect(() => {
        if ((online && !previousOnlineRef.current) || contextDayRef.current !== currentDay) {
            invalidateSeasonCache(leagueId)
            invalidateWeekNumberCache()
        }
        previousOnlineRef.current = online
        contextDayRef.current = currentDay
        void load()
    }, [load, online, currentDay, leagueId])
    useEffect(() => () => { lineupLoadSeqRef.current += 1 }, [])
    useEffect(() => {
        const refresh = () => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
            const day = todayET()
            if (day !== currentDay) setCurrentDay(day)
            else {
                invalidateSeasonCache(leagueId)
                invalidateWeekNumberCache()
                void load()
            }
        }
        const timer = setTimeout(() => setCurrentDay(todayET()), Math.max(1, Date.parse(endOfETDayUTC(currentDay)) - Date.now() + 1))
        window.addEventListener('focus', refresh)
        window.addEventListener('pageshow', refresh)
        document.addEventListener('visibilitychange', refresh)
        return () => {
            clearTimeout(timer)
            window.removeEventListener('focus', refresh)
            window.removeEventListener('pageshow', refresh)
            document.removeEventListener('visibilitychange', refresh)
        }
    }, [currentDay, load, leagueId])

    const ownsLineup = dataOwnerKey === ownerKey
    const visibleCtx = ownsLineup ? ctx : null
    const matchingDay = dataDate === selectedDate
    const visibleStarters = useMemo(() => ownsLineup && matchingDay ? starters : [], [ownsLineup, matchingDay, starters])
    const visibleBench = useMemo(() => ownsLineup && matchingDay ? bench : [], [bench, matchingDay, ownsLineup])
    const readOnly = !ownsLineup || !matchingDay || !online || !contextAuthority || savedSnapshot || lineupLoading || lineupRefreshing || Boolean(lineupError)
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
    const actionContext = !readOnly && current && visibleCtx && currentLeague ? {
        memberId: current.id,
        leagueId: currentLeague.id,
        seasonId: visibleCtx.seasonId,
        weekNumber: visibleCtx.weekNumber,
        seasonYear: visibleCtx.seasonYear,
    } : null
    const lineupForActions = useMemo(
        () => visibleCtx ? { starters: visibleStarters, bench: visibleBench } : null,
        [visibleBench, visibleCtx, visibleStarters],
    )
    const reloadLineupForActions = useCallback(async (date: string) => {
        await load(date)
    }, [load])

    useEffect(() => {
        if (!visibleCtx || !current?.id || !currentLeague) return
        const memberId = current.id
        const lineupCtx = visibleCtx
        const refreshLineup = debounceRealtimeRefresh(() => {
            if (online && document.visibilityState !== 'hidden') void load(selectedDate)
        }, 200)
        const channel = subscribeToTableChanges(
            `lineup-screen:${lineupCtx.seasonId}:${memberId}`,
            {
                mode: 'per-watch',
                watches: [{
                    table: 'weekly_lineups',
                    filter: `league_season_id=eq.${lineupCtx.seasonId}`,
                    onChange: (payload) => {
                        const row = payload.eventType === 'DELETE' ? payload.old : payload.new
                        if (row.member_id !== memberId || row.game_date !== selectedDate) return
                        refreshLineup.trigger()
                    },
                }],
            },
        )

        return () => {
            reportRealtimeCleanup(
                'lineup',
                disposeTableChangeSubscription(channel, [refreshLineup]),
            )
        }
    }, [current?.id, currentLeague, load, selectedDate, visibleCtx, online])
    const {
        selected,
        setSelected,
        saving,
        autoSetting,
        autoSetModalVisible,
        setAutoSetModalVisible,
        handleTap,
        doAutoSet,
        handleAutoSet,
    } = useLineupActions({
        actionContext,
        myLineup: lineupForActions,
        league: currentLeague,
        selectedDate,
        startedTeams,
        reloadLineup: reloadLineupForActions,
    })

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
                  from: selected,
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
        setAutoSetModalVisible(false)
        try {
            await setLineupOptimizerEnabled(
                actionContext.memberId,
                actionContext.leagueId,
                actionContext.seasonId,
                true,
            )
            setSeasonOptimizerEnabled(true)
            await doAutoSet(null, true)
        } catch (e) {
            showAlert('Optimizer failed', getErrorMessage(e))
        }
    }

    async function handleDisableSeasonOptimizer() {
        if (!actionContext) return
        setAutoSetModalVisible(false)
        try {
            await setLineupOptimizerEnabled(
                actionContext.memberId,
                actionContext.leagueId,
                actionContext.seasonId,
                false,
            )
            setSeasonOptimizerEnabled(false)
        } catch (e) {
            showAlert('Optimizer failed', getErrorMessage(e))
        }
    }

    const selectedPlayer =
        selected?.kind === 'starter'
            ? visibleStarters[selected.index]?.player
            : selected?.kind === 'bench'
              ? visibleBench[selected.index]
              : null

    if (!visibleCtx) {
        const emptyMessage = lineupLoading
            ? 'Loading lineup...'
            : lineupError
              ? 'Could not load lineup.'
              : 'No active lineup yet.'
        return (
            <Page title="Lineup">
                <View style={styles.empty}>
                    <Text style={styles.emptyText}>{emptyMessage}</Text>
                    {lineupError ? <Text style={styles.emptySubtext}>{lineupError}</Text> : null}
                    {lineupError ? (
                        <MotionPressable
                            style={styles.retryButton}
                            onPress={() => { void load() }}
                            accessibilityRole="button"
                            accessibilityLabel="Retry lineup load"
                            pressedScale={0.96}
                        >
                            <Text style={styles.retryButtonText}>Try again</Text>
                        </MotionPressable>
                    ) : null}
                </View>
            </Page>
        )
    }

    const rosterEmpty = visibleStarters.every((s) => !s.player) && visibleBench.length === 0

    return (
        <Page title="Lineup">
            <PageHeader
                title={`Week ${visibleCtx.weekNumber} lineup`}
                onBack={() => back()}
                backLabel="Close lineup"
                actions={(
                    <Button
                        title="Auto-set"
                        size="sm"
                        variant="outline"
                        onPress={handleAutoSet}
                        disabled={readOnly || autoSetting || saving || rosterEmpty}
                        accessibilityLabel="Open auto-set lineup options"
                    />
                )}
            />

            {/* Day selector */}
            {weekDays.length > 0 && (
                <DaySelector days={weekDays} selectedDate={selectedDate} onSelect={handleDaySelect} compact={compactDays} />
            )}

            {readOnly ? (
                <View style={styles.statusBanner}>
                    <Text style={styles.statusBannerText}>{!matchingDay ? 'Lineup unavailable for this day' : !online ? 'Saved lineup · Offline · Read only' : lineupError ? 'Saved lineup · Refresh failed · Read only' : 'Updating lineup · Read only'}</Text>
                </View>
            ) : null}

            {lineupError && online ? (
                <View style={styles.errorBanner}>
                    <Text style={styles.errorBannerText}>{lineupError}</Text>
                    <MotionPressable
                        style={styles.errorRetryButton}
                        onPress={() => { void load(selectedDate) }}
                        accessibilityRole="button"
                        accessibilityLabel="Retry selected lineup day"
                        pressedScale={0.96}
                    >
                        <Text style={styles.errorRetryButtonText}>Retry</Text>
                    </MotionPressable>
                </View>
            ) : null}

            {/* Selection hint */}
            {selected && !readOnly && (
                <MotionView style={styles.hint} preset="slide-left">
                    <Text style={styles.hintText}>
                        {selectedPlayer
                            ? `${selectedPlayer.displayName} selected — tap a slot to move`
                            : `Empty ${selected.kind === 'starter' ? visibleStarters[selected.index]?.slotType : ''} slot selected — tap a player`}
                    </Text>
                </MotionView>
            )}

            <ScrollView
                style={styles.scroller}
                contentContainerStyle={[styles.scroll, { paddingHorizontal: padX }, twoColumn && styles.scrollWide]}
            >
                {rosterEmpty && matchingDay ? (
                    <View style={styles.preDraftHint}>
                        <Text style={styles.preDraftHintText}>
                            No players yet — your roster fills as you draft. Draft players to set your Week {visibleCtx.weekNumber} lineup.
                        </Text>
                    </View>
                ) : null}
                <View style={[styles.columns, twoColumn && styles.columnsWide]}>
                <View style={[styles.column, twoColumn && styles.columnWide]}>
                {/* Starters */}
                <Text
                    style={styles.sectionLabel}
                    role="heading"
                    aria-level={2}
                    accessibilityRole="header"
                    accessibilityLabel="Starters"
                >
                    Starters
                </Text>
                <MotionView style={styles.card} preset="rise">
                    {visibleStarters.map((slot, i) => (
                        <StarterRow
                            key={`starter-${i}`}
                            slot={slot}
                            index={i}
                            isSelected={selected?.kind === 'starter' && selected.index === i}
                            liveTeamsRef={liveTeamsRef}
                            teamMatchups={displayedMatchups}
                            onPress={() => handleTap({ kind: 'starter', index: i })}
                            disabled={readOnly || saving || lineupRefreshing || lineupLoading}
                            readOnly={readOnly}
                            targetState={targetState({ kind: 'starter', index: i })}
                        />
                    ))}
                </MotionView>
                </View>

                <View style={[styles.column, twoColumn && styles.columnWide]}>
                {/* Bench */}
                <Text
                    style={styles.sectionLabel}
                    role="heading"
                    aria-level={2}
                    accessibilityRole="header"
                    accessibilityLabel="Bench"
                >
                    Bench
                </Text>
                <MotionView style={styles.card} preset="rise" delay={90}>
                    {visibleBench.length === 0 ? (
                        <Text style={styles.benchEmpty}>{!matchingDay ? 'Connect to load this day.' : rosterEmpty ? 'Your bench fills after the draft' : 'All players are in the starting lineup'}</Text>
                    ) : (
                        visibleBench.map((player, i) => (
                            <BenchRow
                                key={player.playerId}
                                player={player}
                                index={i}
                                isSelected={selected?.kind === 'bench' && selected.index === i}
                                liveTeamsRef={liveTeamsRef}
                                teamMatchups={displayedMatchups}
                                onPress={() => handleTap({ kind: 'bench', index: i })}
                                disabled={readOnly || saving || lineupRefreshing || lineupLoading}
                            readOnly={readOnly}
                                targetState={targetState({ kind: 'bench', index: i })}
                            />
                        ))
                    )}
                </MotionView>
                </View>
                </View>
            </ScrollView>

            <AutoSetModal
                visible={autoSetModalVisible}
                onClose={() => setAutoSetModalVisible(false)}
                onToday={() => { setAutoSetModalVisible(false); doAutoSet(selectedDate) }}
                onWholeWeek={() => { setAutoSetModalVisible(false); doAutoSet(null) }}
                onRestOfSeason={() => { setAutoSetModalVisible(false); doAutoSet(null, true) }}
                seasonOptimizerEnabled={seasonOptimizerEnabled}
                onEnableSeasonOptimizer={handleEnableSeasonOptimizer}
                onDisableSeasonOptimizer={handleDisableSeasonOptimizer}
            />
        </Page>
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

    hint: {
        backgroundColor: colors.primaryLight,
        borderBottomWidth: 1,
        borderBottomColor: colors.primaryBorder,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
    },
    hintText: { fontSize: fontSize.sm, color: colors.primaryDark, fontWeight: fontWeight.medium },

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
        minHeight: 44,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgScreen,
        alignItems: 'center',
        justifyContent: 'center',
    },
    errorRetryButtonText: { fontSize: fontSize.sm, color: colors.dangerDark, fontWeight: fontWeight.bold },

    scroller: { flex: 1, minHeight: 0 },
    scroll: { paddingVertical: spacing.lg, gap: spacing.md, width: '100%', maxWidth: layout.lineupMaxWidth, alignSelf: 'center' },
    scrollWide: { maxWidth: 2 * layout.lineupMaxWidth },
    columns: { gap: spacing.md },
    columnsWide: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing['3xl'] },
    // Only flex side by side; in one column a flex child would shrink inside the scroll view.
    column: { minWidth: 0 },
    columnWide: { flex: 1 },

    sectionLabel: {
        ...textStyles.sectionLabel,
        marginBottom: spacing.sm,
        marginLeft: spacing.xs,
    },

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
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.lg,
        gap: spacing.md,
        minHeight: 52,
    },
    benchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.lg,
        gap: spacing.md,
        minHeight: 52,
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
    playerMeta: { ...textStyles.meta },

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
        letterSpacing: 0.5,
    },
    benchEmpty: { padding: spacing.xl, fontSize: fontSize.sm, color: colors.textPlaceholder, textAlign: 'center' },

    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
    emptyText: { fontSize: fontSize.md, color: colors.textPlaceholder },
    emptySubtext: {
        maxWidth: 320,
        marginTop: spacing.sm,
        ...textStyles.meta,
        textAlign: 'center',
    },
    retryButton: {
        minHeight: 44,
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
