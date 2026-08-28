import { AutoSetModal } from '@/components/AutoSetModal'
import { Avatar } from '@/components/Avatar'
import { DaySelector } from '@/components/DaySelector'
import { PosTag } from '@/components/PosTag'
import { colors, fontSize, fontWeight, radii, spacing, uiColors } from '@/constants/tokens'
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
import { todayET } from '@/lib/shared/dates'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    Alert,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { MotionPressable, MotionView } from '@/components/Motion'

// Memoized row component that only re-renders when its props change
const StarterRow = memo(function StarterRow({
    slot,
    index,
    isSelected,
    liveTeamsRef,
    teamMatchups,
    onPress,
    disabled,
    targetState,
}: {
    slot: LineupSlot
    index: number
    isSelected: boolean
    liveTeamsRef: React.RefObject<Set<string>>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    onPress: () => void
    disabled: boolean
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
    targetState,
}: {
    player: LineupPlayer
    index: number
    isSelected: boolean
    liveTeamsRef: React.RefObject<Set<string>>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    onPress: () => void
    disabled: boolean
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
    const { back } = useRouter()
    const { playerId: playerIdParam } = useLocalSearchParams<{ playerId?: string | string[] }>()
    const requestedPlayerId = Array.isArray(playerIdParam) ? playerIdParam[0] : playerIdParam
    const { user } = useAuth()
    const { current, currentLeague } = useLeagueContext()

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
    const [bench, setBench] = useState<LineupPlayer[]>([])
    const [seasonOptimizerEnabled, setSeasonOptimizerEnabled] = useState(false)
    const [lineupLoading, setLineupLoading] = useState(true)
    const [lineupRefreshing, setLineupRefreshing] = useState(false)
    const [lineupError, setLineupError] = useState<string | null>(null)
    const lineupLoadSeqRef = useRef(0)
    const preselectedKeyRef = useRef<string | null>(null)
    const ownerKey = current?.id && currentLeague?.id ? `${current.id}:${currentLeague.id}` : null
    const [dataOwnerKey, setDataOwnerKey] = useState(ownerKey)

    const { startedTeams, liveTeams, teamMatchups } = useLiveStats(selectedDate)
    // Wrap in a ref so memoized row components read the latest value without re-rendering on poll updates
    const liveTeamsRef = useRef(liveTeams)
    liveTeamsRef.current = liveTeams

    const loadLineup = useCallback(async (
        lineupCtx: LineupContext,
        league: any,
        date: string,
        requestId = ++lineupLoadSeqRef.current,
    ) => {
        const lineup = await getWeeklyLineup(
            current!.id,
            league.id,
            lineupCtx.seasonId,
            lineupCtx.weekNumber,
            date,
        )
        if (lineupLoadSeqRef.current !== requestId) return false
        setStarters(lineup.starters)
        setBench(lineup.bench)
        return true
    }, [current])

    const load = useCallback(async () => {
        const requestId = ++lineupLoadSeqRef.current
        setLineupLoading(true)
        setLineupError(null)
        if (!current || !user || !currentLeague) {
            setDataOwnerKey(ownerKey)
            setCtx(null)
            setWeekDays([])
            setStarters([])
            setBench([])
            setLineupLoading(false)
            return
        }
        try {
            const lineupCtx = await getLineupContext(currentLeague.id)
            if (lineupLoadSeqRef.current !== requestId) return
            if (!lineupCtx) {
                setDataOwnerKey(ownerKey)
                setCtx(null)
                setWeekDays([])
                setStarters([])
                setBench([])
                return
            }
            const days = await getWeekDays(lineupCtx.weekNumber, lineupCtx.seasonYear)
            if (lineupLoadSeqRef.current !== requestId) return
            const selected = clampDateToWeek(lineupCtx.today, days)
            const optimizerEnabled = await getLineupOptimizerEnabled(current.id, currentLeague.id, lineupCtx.seasonId)
            if (lineupLoadSeqRef.current !== requestId) return
            const lineup = await getWeeklyLineup(
                current.id,
                currentLeague.id,
                lineupCtx.seasonId,
                lineupCtx.weekNumber,
                selected,
            )
            if (lineupLoadSeqRef.current !== requestId) return
            setDataOwnerKey(ownerKey)
            setCtx(lineupCtx)
            setSelectedDate(selected)
            setWeekDays(days)
            setSeasonOptimizerEnabled(optimizerEnabled)
            setStarters(lineup.starters)
            setBench(lineup.bench)
        } catch (e) {
            console.error(e)
            if (lineupLoadSeqRef.current === requestId) {
                setCtx(null)
                setLineupError(getErrorMessage(e) ?? 'Could not load lineup.')
            }
        } finally {
            if (lineupLoadSeqRef.current === requestId) setLineupLoading(false)
        }
    }, [current, currentLeague, ownerKey, user])

    useEffect(() => { load() }, [load])

    const ownsLineup = dataOwnerKey === ownerKey
    const visibleCtx = ownsLineup ? ctx : null
    const visibleStarters = useMemo(() => ownsLineup ? starters : [], [ownsLineup, starters])
    const visibleBench = useMemo(() => ownsLineup ? bench : [], [bench, ownsLineup])
    const actionContext = current && visibleCtx && currentLeague ? {
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
        if (!visibleCtx || !currentLeague) return
        setLineupError(null)
        await loadLineup(visibleCtx, currentLeague, date)
    }, [visibleCtx, currentLeague, loadLineup])

    useEffect(() => {
        if (!visibleCtx || !current?.id || !currentLeague) return
        const memberId = current.id
        const league = currentLeague
        const lineupCtx = visibleCtx
        const refreshLineup = debounceRealtimeRefresh(() => {
            void loadLineup(lineupCtx, league, selectedDate)
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
    }, [current?.id, currentLeague, loadLineup, selectedDate, visibleCtx])
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
        if (!requestedPlayerId || lineupLoading || lineupRefreshing || !lineupForActions) return
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
    }, [lineupForActions, lineupLoading, lineupRefreshing, ownerKey, requestedPlayerId, selectedDate, setSelected, visibleBench, visibleStarters])

    const targetState = (to: { kind: 'starter' | 'bench'; index: number }) =>
        lineupForActions && currentLeague
            ? getLineupMoveTargetState({
                  lineup: lineupForActions,
                  league: currentLeague,
                  startedTeams,
                  from: selected,
                  to,
              })
            : null

    async function handleDaySelect(date: string) {
        if (!visibleCtx || !currentLeague) return
        const requestId = ++lineupLoadSeqRef.current
        setSelectedDate(date)
        setSelected(null)
        setLineupRefreshing(true)
        setLineupError(null)
        try {
            await loadLineup(visibleCtx, currentLeague, date, requestId)
        } catch (e) {
            console.error(e)
            if (lineupLoadSeqRef.current === requestId) {
                setLineupError(getErrorMessage(e) ?? 'Could not load lineup.')
            }
        } finally {
            if (lineupLoadSeqRef.current === requestId) setLineupRefreshing(false)
        }
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
            Alert.alert('Optimizer failed', e instanceof Error ? e.message : String(e))
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
            Alert.alert('Optimizer failed', e instanceof Error ? e.message : String(e))
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
            <SafeAreaView style={styles.container}>
                <View style={styles.empty}>
                    <Text style={styles.emptyText}>{emptyMessage}</Text>
                    {lineupError ? <Text style={styles.emptySubtext}>{lineupError}</Text> : null}
                    {lineupError ? (
                        <MotionPressable
                            style={styles.retryButton}
                            onPress={load}
                            accessibilityRole="button"
                            accessibilityLabel="Retry lineup load"
                            pressedScale={0.96}
                        >
                            <Text style={styles.retryButtonText}>Try again</Text>
                        </MotionPressable>
                    ) : null}
                </View>
            </SafeAreaView>
        )
    }

    const rosterEmpty = visibleStarters.every((s) => !s.player) && visibleBench.length === 0

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            {/* Header */}
            <View style={styles.header}>
                <MotionPressable
                    onPress={() => back()}
                    style={styles.closeButton}
                    accessibilityRole="button"
                    accessibilityLabel="Close lineup"
                    pressedScale={0.92}
                >
                    <Text style={styles.closeText}>Done</Text>
                </MotionPressable>
                <Text
                    style={styles.headerTitle}
                    role="heading"
                    aria-level={2}
                    accessibilityRole="header"
                >
                    Week {visibleCtx.weekNumber} Lineup
                </Text>
                <MotionPressable
                    style={[styles.autoSetButton, rosterEmpty && styles.autoSetButtonDisabled]}
                    onPress={handleAutoSet}
                    disabled={autoSetting || saving || rosterEmpty}
                    accessibilityRole="button"
                    accessibilityLabel="Open auto-set lineup options"
                    accessibilityState={{ disabled: autoSetting || saving || rosterEmpty }}
                    pressedScale={0.92}
                >
                    <Text style={[styles.autoSetText, rosterEmpty && styles.autoSetTextDisabled]}>Auto-Set</Text>
                </MotionPressable>
            </View>

            {/* Day selector */}
            {weekDays.length > 0 && (
                <DaySelector days={weekDays} selectedDate={selectedDate} onSelect={handleDaySelect} />
            )}

            {lineupRefreshing ? (
                <View style={styles.statusBanner}>
                    <Text style={styles.statusBannerText}>Refreshing lineup...</Text>
                </View>
            ) : null}

            {lineupError ? (
                <View style={styles.errorBanner}>
                    <Text style={styles.errorBannerText}>{lineupError}</Text>
                    <MotionPressable
                        style={styles.errorRetryButton}
                        onPress={() => { void handleDaySelect(selectedDate) }}
                        accessibilityRole="button"
                        accessibilityLabel="Retry selected lineup day"
                        pressedScale={0.96}
                    >
                        <Text style={styles.errorRetryButtonText}>Retry</Text>
                    </MotionPressable>
                </View>
            ) : null}

            {/* Selection hint */}
            {selected && (
                <MotionView style={styles.hint} preset="slide-left">
                    <Text style={styles.hintText}>
                        {selectedPlayer
                            ? `${selectedPlayer.displayName} selected — tap a slot to move`
                            : `Empty ${selected.kind === 'starter' ? visibleStarters[selected.index]?.slotType : ''} slot selected — tap a player`}
                    </Text>
                </MotionView>
            )}

            <ScrollView style={styles.scroller} contentContainerStyle={styles.scroll}>
                {rosterEmpty ? (
                    <View style={styles.preDraftHint}>
                        <Text style={styles.preDraftHintText}>
                            No players yet — your roster fills as you draft. Draft players to set your Week {visibleCtx.weekNumber} lineup.
                        </Text>
                    </View>
                ) : null}
                {/* Starters */}
                <Text
                    style={styles.sectionLabel}
                    role="heading"
                    aria-level={2}
                    accessibilityRole="header"
                    accessibilityLabel="Starters"
                >
                    STARTERS
                </Text>
                <MotionView style={styles.card} preset="rise">
                    {visibleStarters.map((slot, i) => (
                        <StarterRow
                            key={`starter-${i}`}
                            slot={slot}
                            index={i}
                            isSelected={selected?.kind === 'starter' && selected.index === i}
                            liveTeamsRef={liveTeamsRef}
                            teamMatchups={teamMatchups}
                            onPress={() => handleTap({ kind: 'starter', index: i })}
                            disabled={saving || lineupRefreshing || lineupLoading}
                            targetState={targetState({ kind: 'starter', index: i })}
                        />
                    ))}
                </MotionView>

                {/* Bench */}
                <Text
                    style={styles.sectionLabel}
                    role="heading"
                    aria-level={2}
                    accessibilityRole="header"
                    accessibilityLabel="Bench"
                >
                    BENCH
                </Text>
                <MotionView style={styles.card} preset="rise" delay={90}>
                    {visibleBench.length === 0 ? (
                        <Text style={styles.benchEmpty}>{rosterEmpty ? 'Your bench fills after the draft' : 'All players are in the starting lineup'}</Text>
                    ) : (
                        visibleBench.map((player, i) => (
                            <BenchRow
                                key={player.playerId}
                                player={player}
                                index={i}
                                isSelected={selected?.kind === 'bench' && selected.index === i}
                                liveTeamsRef={liveTeamsRef}
                                teamMatchups={teamMatchups}
                                onPress={() => handleTap({ kind: 'bench', index: i })}
                                disabled={saving || lineupRefreshing || lineupLoading}
                                targetState={targetState({ kind: 'bench', index: i })}
                            />
                        ))
                    )}
                </MotionView>
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
        </SafeAreaView>
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgSubtle },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: 14,
        backgroundColor: colors.bgScreen,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    closeButton: { minWidth: 64, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    closeText: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.primaryDark },
    headerTitle: { flex: 1, fontSize: 18, fontWeight: fontWeight.extrabold, textAlign: 'center' },
    autoSetButton: {
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        borderWidth: 1.5,
        borderColor: colors.primary,
        minWidth: 80,
        minHeight: 48,
        alignItems: 'center',
        justifyContent: 'center',
    },
    autoSetText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
    autoSetButtonDisabled: { borderColor: colors.borderLight, backgroundColor: colors.bgMuted, opacity: 0.55 },
    autoSetTextDisabled: { color: colors.textMuted },
    preDraftHint: {
        padding: spacing.lg,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primaryLight,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
    },
    preDraftHintText: { fontSize: fontSize.sm, color: colors.primaryDark, fontWeight: fontWeight.medium, lineHeight: 18 },

    hint: {
        backgroundColor: colors.primaryLight,
        borderBottomWidth: 1,
        borderBottomColor: colors.primaryBorder,
        paddingHorizontal: spacing.xl,
        paddingVertical: 10,
    },
    hintText: { fontSize: fontSize.sm, color: colors.primaryDark, fontWeight: fontWeight.medium },

    statusBanner: {
        backgroundColor: colors.primaryLight,
        borderBottomWidth: 1,
        borderBottomColor: colors.primaryBorder,
        paddingHorizontal: spacing.xl,
        paddingVertical: 10,
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
        paddingVertical: 10,
    },
    errorBannerText: { flex: 1, fontSize: fontSize.sm, color: colors.danger, fontWeight: fontWeight.medium },
    errorRetryButton: {
        minHeight: 36,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgScreen,
        alignItems: 'center',
        justifyContent: 'center',
    },
    errorRetryButtonText: { fontSize: fontSize.sm, color: colors.danger, fontWeight: fontWeight.bold },

    scroller: { flex: 1, minHeight: 0 },
    scroll: { padding: spacing.xl, gap: spacing.md, width: '100%', maxWidth: 640, alignSelf: 'center' },

    sectionLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0,
        marginBottom: spacing.xs,
        marginLeft: spacing.xs,
    },

    card: {
        backgroundColor: colors.bgScreen,
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        marginBottom: spacing.lg,
        overflow: 'hidden',
    },

    slotRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 14,
        gap: 10,
        minHeight: 56,
    },
    benchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 14,
        gap: 10,
        minHeight: 56,
    },
    divider: { borderTopWidth: 1, borderTopColor: colors.separator },
    selectedRow: { backgroundColor: colors.primaryLight },
    validTargetRow: { backgroundColor: colors.successLight },
    invalidTargetRow: { opacity: 0.38 },

    slotLabel: {
        width: 36,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        color: colors.textPlaceholder,
        letterSpacing: 0,
    },

    playerInfo: { flex: 1, gap: 1 },
    playerName: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    playerMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    playerMeta: { fontSize: 12, color: colors.textMuted },

    emptySlot: { fontSize: fontSize.md, color: colors.textMuted, fontStyle: 'italic' },
    lockedBadge: {
        fontSize: 10,
        fontWeight: fontWeight.bold,
        color: uiColors.successTextLive,
        letterSpacing: 0,
    },
    moveBadge: {
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.extrabold,
        color: colors.successDark,
        letterSpacing: 0.5,
    },
    benchEmpty: { padding: spacing.xl, fontSize: fontSize.sm, color: colors.textPlaceholder, textAlign: 'center' },

    empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    emptyText: { fontSize: fontSize.md, color: colors.textPlaceholder },
    emptySubtext: {
        maxWidth: 320,
        marginTop: spacing.sm,
        fontSize: fontSize.sm,
        lineHeight: 18,
        color: colors.textMuted,
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
