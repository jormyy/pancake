import { AutoSetModal } from '@/components/AutoSetModal'
import { Avatar } from '@/components/Avatar'
import { DaySelector } from '@/components/DaySelector'
import { LoadingScreen } from '@/components/LoadingScreen'
import { PosTag } from '@/components/PosTag'
import { POSITION_COLORS } from '@/constants/positions'
import { colors, fontSize, fontWeight, palette, radii, spacing } from '@/constants/tokens'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import {
    autoSetLineup,
    canPlaySlot,
    getLineupContext,
    getLiveTeams,
    getStartedTeams,
    getTeamMatchups,
    getWeekDays,
    getWeeklyLineup,
    LineupContext,
    LineupPlayer,
    LineupSlot,
    setPlayerSlot,
    WeekDay,
} from '@/lib/lineup'
import { todayDateString } from '@/lib/shared/dates'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import {
    ActivityIndicator,
    Alert,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

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
    const [teamMatchups, setTeamMatchups] = useState<Map<string, { opponent: string; isHome: boolean }>>(new Map())
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [autoSetting, setAutoSetting] = useState(false)
    const [autoSetModalVisible, setAutoSetModalVisible] = useState(false)
    const [selected, setSelected] = useState<Selection | null>(null)

    const loadLineup = useCallback(async (lineupCtx: LineupContext, league: any, date: string) => {
        console.log('[lineup] loadLineup called for date:', date)
        const [lineup, started, live, matchups] = await Promise.all([
            getWeeklyLineup(
                current!.id,
                league.id,
                lineupCtx.seasonId,
                lineupCtx.weekNumber,
                date,
            ),
            getStartedTeams(date),
            getLiveTeams(date),
            getTeamMatchups(date),
        ])
        setStarters(lineup.starters)
        setBench(lineup.bench)
        setStartedTeams(started)
        setLiveTeams(live)
        setTeamMatchups(matchups)
        console.log('[lineup] teamMatchups size:', matchups.size, [...matchups.entries()])
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
        if (aPlayer && bSlot !== 'BE' && !canPlaySlot(aPlayer.eligiblePositions, bSlot)) {
            Alert.alert('Invalid move', `${aPlayer.displayName} can't play ${bSlot}`)
            return
        }
        if (bPlayer && aSlot !== 'BE' && !canPlaySlot(bPlayer.eligiblePositions, aSlot)) {
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
        setAutoSetModalVisible(true)
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
                <DaySelector days={weekDays} selectedDate={selectedDate} onSelect={handleDaySelect} />
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
                        const starterMatchup = p?.nbaTeam ? teamMatchups.get(p.nbaTeam) : undefined
                        const starterMatchupLabel = p?.nbaTeam
                            ? (starterMatchup ? `${starterMatchup.isHome ? 'vs' : '@'} ${starterMatchup.opponent}` : 'No game')
                            : null
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
                                            <View style={styles.playerMetaRow}>
                                                {p.eligiblePositions.map((pos) => <PosTag key={pos} position={pos} />)}
                                                {starterMatchupLabel !== null && (
                                                    <Text style={styles.playerMeta}>{p.nbaTeam} · {starterMatchupLabel}</Text>
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
                            const benchMatchup = player.nbaTeam ? teamMatchups.get(player.nbaTeam) : undefined
                            const benchMatchupLabel = player.nbaTeam
                                ? (benchMatchup ? `${benchMatchup.isHome ? 'vs' : '@'} ${benchMatchup.opponent}` : 'No game')
                                : null
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
                                        <View style={styles.playerMetaRow}>
                                            {player.eligiblePositions.map((pos) => <PosTag key={pos} position={pos} />)}
                                            {benchMatchupLabel !== null && (
                                                <Text style={styles.playerMeta}>{player.nbaTeam} · {benchMatchupLabel}</Text>
                                            )}
                                        </View>
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

            <AutoSetModal
                visible={autoSetModalVisible}
                onClose={() => setAutoSetModalVisible(false)}
                onToday={() => { setAutoSetModalVisible(false); doAutoSet(selectedDate) }}
                onWholeWeek={() => { setAutoSetModalVisible(false); doAutoSet(null) }}
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
    playerMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
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
