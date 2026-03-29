import {
    View,
    Text,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    Alert,
    ScrollView,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import {
    getLineupContext,
    getWeekDays,
    getWeeklyLineup,
    setPlayerSlot,
    autoSetLineup,
    getStartedTeams,
    getLiveTeams,
    canPlaySlot,
    LineupSlot,
    LineupPlayer,
    LineupContext,
    WeekDay,
} from '@/lib/lineup'
import { POSITION_COLORS } from '@/constants/positions'
import { Avatar } from '@/components/Avatar'
import { LoadingScreen } from '@/components/LoadingScreen'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { todayDateString } from '@/lib/shared/dates'

type Selection =
    | { kind: 'starter'; index: number }
    | { kind: 'bench'; index: number }

export default function LineupScreen() {
    const { back } = useRouter()
    const { user } = useAuth()
    const { current } = useLeagueContext()

    const [ctx, setCtx] = useState<LineupContext | null>(null)
    const [weekDays, setWeekDays] = useState<WeekDay[]>([])
    const [selectedDate, setSelectedDate] = useState<string>(
        () => todayDateString(),
    )
    const [starters, setStarters] = useState<LineupSlot[]>([])
    const [bench, setBench] = useState<LineupPlayer[]>([])
    const [startedTeams, setStartedTeams] = useState<Set<string>>(new Set())
    const [liveTeams, setLiveTeams] = useState<Set<string>>(new Set())
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [autoSetting, setAutoSetting] = useState(false)
    const [selected, setSelected] = useState<Selection | null>(null)

    const loadLineup = useCallback(async (lineupCtx: LineupContext, league: any, date: string) => {
        const [lineup, started, live] = await Promise.all([
            getWeeklyLineup(
                current!.id,
                league.id,
                lineupCtx.seasonId,
                lineupCtx.weekNumber,
                date,
            ),
            getStartedTeams(date),
            getLiveTeams(date),
        ])
        setStarters(lineup.starters)
        setBench(lineup.bench)
        setStartedTeams(started)
        setLiveTeams(live)
    }, [current])

    const load = useCallback(async () => {
        if (!current || !user) return
        const league = current.leagues as any
        setLoading(true)
        try {
            const lineupCtx = await getLineupContext(league.id)
            if (!lineupCtx) { setLoading(false); return }
            setCtx(lineupCtx)
            setSelectedDate(lineupCtx.today)
            const days = await getWeekDays(lineupCtx.weekNumber, lineupCtx.seasonYear)
            setWeekDays(days)
            await loadLineup(lineupCtx, league, lineupCtx.today)
        } catch (e) {
            console.error(e)
        } finally {
            setLoading(false)
        }
    }, [current, user, loadLineup])

    useEffect(() => { load() }, [load])

    // Refresh started/live teams every 15s when viewing today (games can go InProgress mid-session)
    useEffect(() => {
        const today = todayDateString()
        if (selectedDate !== today) return
        const interval = setInterval(() => {
            getStartedTeams(selectedDate).then(setStartedTeams).catch(() => {})
            getLiveTeams(selectedDate).then(setLiveTeams).catch(() => {})
        }, 15_000)
        return () => clearInterval(interval)
    }, [selectedDate])

    async function handleTap(newSel: Selection) {
        // Block all moves on past days
        if (selectedDate < todayDateString()) {
            Alert.alert('Past lineup', 'Lineups for past days cannot be changed.')
            return
        }

        // First tap — select
        if (!selected) {
            setSelected(newSel)
            return
        }

        // Same item tapped again — deselect
        if (selected.kind === newSel.kind && selected.index === newSel.index) {
            setSelected(null)
            return
        }

        setSelected(null)

        const league = current?.leagues as any
        if (!current || !ctx) return

        const aPlayer = selected.kind === 'starter' ? starters[selected.index].player : bench[selected.index]
        const bPlayer = newSel.kind === 'starter' ? starters[newSel.index].player : bench[newSel.index]
        const aSlot = selected.kind === 'starter' ? starters[selected.index].slotType : 'BE'
        const bSlot = newSel.kind === 'starter' ? starters[newSel.index].slotType : 'BE'

        // Block any move involving a player whose game has already started (InProgress or Final)
        const aLocked = !!(aPlayer?.nbaTeam && startedTeams.has(aPlayer.nbaTeam))
        const bLocked = !!(bPlayer?.nbaTeam && startedTeams.has(bPlayer.nbaTeam))
        if (aLocked || bLocked) {
            const who = aLocked ? aPlayer! : bPlayer!
            Alert.alert('Lineup locked', `${who.displayName}'s game has already started. No lineup changes are allowed once a game begins.`)
            return
        }

        // Validate eligibility
        if (aPlayer && bSlot !== 'BE' && !canPlaySlot(aPlayer.position, bSlot)) {
            Alert.alert('Invalid move', `${aPlayer.displayName} can't play ${bSlot}`)
            return
        }
        if (bPlayer && aSlot !== 'BE' && !canPlaySlot(bPlayer.position, aSlot)) {
            Alert.alert('Invalid move', `${bPlayer.displayName} can't play ${aSlot}`)
            return
        }

        setSaving(true)
        try {
            const saves: Promise<void>[] = []
            if (aPlayer) saves.push(setPlayerSlot(current.id, league.id, ctx.seasonId, ctx.weekNumber, selectedDate, aPlayer.playerId, bSlot))
            if (bPlayer) saves.push(setPlayerSlot(current.id, league.id, ctx.seasonId, ctx.weekNumber, selectedDate, bPlayer.playerId, aSlot))
            await Promise.all(saves)
            await loadLineup(ctx, league, selectedDate)
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setSaving(false)
        }
    }

    async function doAutoSet(date: string | null) {
        if (!current || !ctx) return
        const league = current.leagues as any
        setAutoSetting(true)
        try {
            await autoSetLineup(current.id, league.id, ctx.seasonId, ctx.weekNumber, ctx.seasonYear, date)
            await loadLineup(ctx, league, selectedDate)
        } catch (e: any) {
            Alert.alert('Auto-set failed', e.message)
        } finally {
            setAutoSetting(false)
        }
    }

    function handleAutoSet() {
        doAutoSet(null)
    }

    async function handleDaySelect(date: string) {
        if (!ctx) return
        const league = (current as any)?.leagues
        setSelectedDate(date)
        setSelected(null)
        await loadLineup(ctx, league, date)
    }

    const selectedPlayer =
        selected?.kind === 'starter'
            ? starters[selected.index]?.player
            : selected?.kind === 'bench'
              ? bench[selected.index]
              : null

    if (loading) {
        return <LoadingScreen />
    }

    if (!ctx) {
        return (
            <SafeAreaView style={styles.container}>
                <View style={styles.empty}>
                    <Text style={styles.emptyText}>No active season found.</Text>
                </View>
            </SafeAreaView>
        )
    }

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            {/* Header */}
            <View style={styles.header}>
                <Pressable onPress={() => back()} style={styles.closeButton}>
                    <Text style={styles.closeText}>Done</Text>
                </Pressable>
                <Text style={styles.headerTitle}>Week {ctx.weekNumber} Lineup</Text>
                <Pressable
                    style={styles.autoSetButton}
                    onPress={handleAutoSet}
                    disabled={autoSetting || saving}
                >
                    {autoSetting ? (
                        <ActivityIndicator size="small" color={colors.primary} />
                    ) : (
                        <Text style={styles.autoSetText}>Auto-Set</Text>
                    )}
                </Pressable>
            </View>

            {/* Day selector */}
            {weekDays.length > 0 && (
                <FlashList
                    horizontal
                    data={weekDays}
                    keyExtractor={(d) => d.date}
                    showsHorizontalScrollIndicator={false}
                    style={styles.daySelectorRow}
                    contentContainerStyle={styles.daySelectorContent}
                    renderItem={({ item: day }) => {
                        const isSelected = day.date === selectedDate
                        return (
                            <Pressable
                                style={[
                                    styles.dayCell,
                                    isSelected && styles.dayCellSelected,
                                    day.isToday && !isSelected && styles.dayCellToday,
                                    !day.hasGames && styles.dayCellNoGames,
                                ]}
                                onPress={() => handleDaySelect(day.date)}
                            >
                                <Text style={[styles.dayLabel, isSelected && styles.dayLabelSelected]}>
                                    {day.dayLabel}
                                </Text>
                                <Text style={[styles.dayNum, isSelected && styles.dayNumSelected]}>
                                    {day.dateNum}
                                </Text>
                                {day.hasGames && (
                                    <View style={[styles.gameDot, isSelected && styles.gameDotSelected]} />
                                )}
                            </Pressable>
                        )
                    }}
                />
            )}

            {/* Selection hint */}
            {selected && (
                <View style={styles.hint}>
                    <Text style={styles.hintText}>
                        {selectedPlayer
                            ? `${selectedPlayer.displayName} selected — tap a slot to move`
                            : `Empty ${selected.kind === 'starter' ? starters[selected.index]?.slotType : ''} slot selected — tap a player`}
                    </Text>
                </View>
            )}

            <ScrollView contentContainerStyle={styles.scroll}>
                {/* Starters */}
                <Text style={styles.sectionLabel}>STARTERS</Text>
                <View style={styles.card}>
                    {starters.map((slot, i) => {
                        const isSelected = selected?.kind === 'starter' && selected.index === i
                        const p = slot.player
                        const isLocked = !!(p?.nbaTeam && liveTeams.has(p.nbaTeam))
                        return (
                            <Pressable
                                key={`starter-${i}`}
                                style={[
                                    styles.slotRow,
                                    i > 0 && styles.divider,
                                    isSelected && styles.selectedRow,
                                ]}
                                onPress={() => handleTap({ kind: 'starter', index: i })}
                                disabled={saving}
                            >
                                <Text style={styles.slotLabel}>{slot.slotType}</Text>
                                {p ? (
                                    <>
                                        <Avatar
                                            name={p.displayName}
                                            color={POSITION_COLORS[p.position ?? ''] ?? palette.gray500}
                                            size={36}
                                        />
                                        <View style={styles.playerInfo}>
                                            <Text style={styles.playerName}>{p.displayName}</Text>
                                            <Text style={styles.playerMeta}>
                                                {[p.nbaTeam, p.position].filter(Boolean).join(' · ')}
                                            </Text>
                                        </View>
                                        {isLocked && (
                                            <Text style={styles.lockedBadge}>LIVE</Text>
                                        )}
                                    </>
                                ) : (
                                    <Text style={styles.emptySlot}>Empty</Text>
                                )}
                            </Pressable>
                        )
                    })}
                </View>

                {/* Bench */}
                <Text style={styles.sectionLabel}>BENCH</Text>
                <View style={styles.card}>
                    {bench.length === 0 ? (
                        <Text style={styles.benchEmpty}>All players are in the starting lineup</Text>
                    ) : (
                        bench.map((player, i) => {
                            const isSelected = selected?.kind === 'bench' && selected.index === i
                            const isLocked = !!(player.nbaTeam && liveTeams.has(player.nbaTeam))
                            return (
                                <Pressable
                                    key={player.playerId}
                                    style={[
                                        styles.benchRow,
                                        i > 0 && styles.divider,
                                        isSelected && styles.selectedRow,
                                    ]}
                                    onPress={() => handleTap({ kind: 'bench', index: i })}
                                    disabled={saving}
                                >
                                    <Avatar
                                        name={player.displayName}
                                        color={POSITION_COLORS[player.position ?? ''] ?? palette.gray500}
                                        size={36}
                                    />
                                    <View style={styles.playerInfo}>
                                        <Text style={styles.playerName}>{player.displayName}</Text>
                                        <Text style={styles.playerMeta}>
                                            {[player.nbaTeam, player.position].filter(Boolean).join(' · ')}
                                        </Text>
                                    </View>
                                    {isLocked && (
                                        <Text style={styles.lockedBadge}>LIVE</Text>
                                    )}
                                </Pressable>
                            )
                        })
                    )}
                </View>
            </ScrollView>

            {saving && (
                <View style={styles.savingOverlay}>
                    <ActivityIndicator color={colors.primary} />
                </View>
            )}
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
    closeButton: { minWidth: 48 },
    closeText: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.primary },
    headerTitle: { flex: 1, fontSize: 18, fontWeight: fontWeight.extrabold, textAlign: 'center' },
    autoSetButton: {
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        borderWidth: 1.5,
        borderColor: colors.primary,
        minWidth: 80,
        alignItems: 'center',
    },
    autoSetText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primary },

    daySelectorRow: { borderBottomWidth: 1, borderBottomColor: colors.borderLight },
    daySelectorContent: { flexDirection: 'row', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm },
    dayCell: { width: 38, alignItems: 'center', paddingVertical: 5, borderRadius: 9, borderCurve: 'continuous' as const, gap: spacing.xxs },
    dayCellSelected: { backgroundColor: colors.primary },
    dayCellToday: { backgroundColor: colors.primaryLight },
    dayCellNoGames: { opacity: 0.4 },
    dayLabel: { fontSize: 10, fontWeight: fontWeight.bold, color: colors.textMuted },
    dayLabelSelected: { color: colors.textWhite },
    dayNum: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    dayNumSelected: { color: colors.textWhite },
    gameDot: { width: 4, height: 4, borderRadius: 2, borderCurve: 'continuous' as const, backgroundColor: colors.primary, marginTop: 1 },
    gameDotSelected: { backgroundColor: 'rgba(255,255,255,0.7)' },

    hint: {
        backgroundColor: colors.primaryLight,
        borderBottomWidth: 1,
        borderBottomColor: palette.orange200,
        paddingHorizontal: spacing.xl,
        paddingVertical: 10,
    },
    hintText: { fontSize: fontSize.sm, color: colors.primaryDark, fontWeight: fontWeight.medium },

    scroll: { padding: spacing.xl, gap: spacing.md },

    sectionLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0.5,
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
        letterSpacing: 0.3,
    },

    playerInfo: { flex: 1, gap: 1 },
    playerName: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    playerMeta: { fontSize: 12, color: colors.textMuted },

    emptySlot: { fontSize: fontSize.md, color: palette.gray500, fontStyle: 'italic' },
    lockedBadge: {
        fontSize: 10,
        fontWeight: fontWeight.bold,
        color: '#16a34a',
        letterSpacing: 0.4,
    },
    benchEmpty: { padding: spacing.xl, fontSize: fontSize.sm, color: colors.textPlaceholder, textAlign: 'center' },

    empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    emptyText: { fontSize: fontSize.md, color: colors.textPlaceholder },

    savingOverlay: {
        position: 'absolute',
        bottom: 24,
        alignSelf: 'center',
        backgroundColor: 'rgba(0,0,0,0.6)',
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing['2xl'],
        paddingVertical: 10,
    },
})
