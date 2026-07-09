import { AutoSetModal } from '@/components/AutoSetModal'
import { Avatar } from '@/components/Avatar'
import { DaySelector } from '@/components/DaySelector'
import { PosTag } from '@/components/PosTag'
import { colors, fontSize, fontWeight, radii, scrim, spacing, uiColors } from '@/constants/tokens'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { useLineupActions } from '@/hooks/use-lineup-actions'
import { useLiveStats } from '@/hooks/use-live-stats'
import { getErrorMessage } from '@/lib/alert'
import {
    clampDateToWeek,
    getLineupContext,
    getWeekDays,
    getWeeklyLineup,
    LineupContext,
    LineupPlayer,
    LineupSlot,
    WeekDay,
} from '@/lib/lineup'
import { getLineupOptimizerEnabled, setLineupOptimizerEnabled } from '@/lib/lineup/optimizerSettings'
import { playerHeadshotUrl } from '@/lib/format'
import { todayET } from '@/lib/shared/dates'
import { useRouter } from 'expo-router'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
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
}: {
    slot: LineupSlot
    index: number
    isSelected: boolean
    liveTeamsRef: React.RefObject<Set<string>>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    onPress: () => void
    disabled: boolean
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
            ]}
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={p ? `${slot.slotType} ${p.displayName}` : `Empty ${slot.slotType} slot`}
            accessibilityState={{ selected: isSelected, disabled }}
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
}: {
    player: LineupPlayer
    index: number
    isSelected: boolean
    liveTeamsRef: React.RefObject<Set<string>>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    onPress: () => void
    disabled: boolean
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
            ]}
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={`Bench ${player.displayName}`}
            accessibilityState={{ selected: isSelected, disabled }}
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
        </MotionPressable>
    )
})

export default function LineupScreen() {
    const { back } = useRouter()
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
    }, [current, currentLeague, user])

    useEffect(() => { load() }, [load])

    const actionContext = current && ctx && currentLeague ? {
        memberId: current.id,
        leagueId: currentLeague.id,
        seasonId: ctx.seasonId,
        weekNumber: ctx.weekNumber,
        seasonYear: ctx.seasonYear,
    } : null
    const lineupForActions = ctx ? { starters, bench } : null
    const reloadLineupForActions = useCallback(async (date: string) => {
        if (!ctx || !currentLeague) return
        setLineupError(null)
        await loadLineup(ctx, currentLeague, date)
    }, [ctx, currentLeague, loadLineup])
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

    async function handleDaySelect(date: string) {
        if (!ctx || !currentLeague) return
        const requestId = ++lineupLoadSeqRef.current
        setSelectedDate(date)
        setSelected(null)
        setLineupRefreshing(true)
        setLineupError(null)
        try {
            await loadLineup(ctx, currentLeague, date, requestId)
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
            ? starters[selected.index]?.player
            : selected?.kind === 'bench'
              ? bench[selected.index]
              : null

    if (!ctx) {
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

    const rosterEmpty = starters.every((s) => !s.player) && bench.length === 0

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
                    Week {ctx.weekNumber} Lineup
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
                            : `Empty ${selected.kind === 'starter' ? starters[selected.index]?.slotType : ''} slot selected — tap a player`}
                    </Text>
                </MotionView>
            )}

            <ScrollView style={styles.scroller} contentContainerStyle={styles.scroll}>
                {rosterEmpty ? (
                    <View style={styles.preDraftHint}>
                        <Text style={styles.preDraftHintText}>
                            No players yet — your roster fills as you draft. Draft players to set your Week {ctx.weekNumber} lineup.
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
                    {starters.map((slot, i) => (
                        <StarterRow
                            key={`starter-${i}`}
                            slot={slot}
                            index={i}
                            isSelected={selected?.kind === 'starter' && selected.index === i}
                            liveTeamsRef={liveTeamsRef}
                            teamMatchups={teamMatchups}
                            onPress={() => handleTap({ kind: 'starter', index: i })}
                            disabled={saving || lineupRefreshing}
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
                    {bench.length === 0 ? (
                        <Text style={styles.benchEmpty}>{rosterEmpty ? 'Your bench fills after the draft' : 'All players are in the starting lineup'}</Text>
                    ) : (
                        bench.map((player, i) => (
                            <BenchRow
                                key={player.playerId}
                                player={player}
                                index={i}
                                isSelected={selected?.kind === 'bench' && selected.index === i}
                                liveTeamsRef={liveTeamsRef}
                                teamMatchups={teamMatchups}
                                onPress={() => handleTap({ kind: 'bench', index: i })}
                                disabled={saving || lineupRefreshing}
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

    savingOverlay: {
        position: 'absolute',
        bottom: 24,
        alignSelf: 'center',
        backgroundColor: scrim,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing['2xl'],
        paddingVertical: 10,
    },

})
