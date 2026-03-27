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
    canPlaySlot,
    LineupSlot,
    LineupPlayer,
    LineupContext,
    WeekDay,
} from '@/lib/lineup'
import { POSITION_COLORS } from '@/constants/positions'

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
        () => new Date().toISOString().split('T')[0],
    )
    const [starters, setStarters] = useState<LineupSlot[]>([])
    const [bench, setBench] = useState<LineupPlayer[]>([])
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [autoSetting, setAutoSetting] = useState(false)
    const [selected, setSelected] = useState<Selection | null>(null)

    const loadLineup = useCallback(async (lineupCtx: LineupContext, league: any, date: string) => {
        const lineup = await getWeeklyLineup(
            current!.id,
            league.id,
            lineupCtx.seasonId,
            lineupCtx.weekNumber,
            date,
        )
        setStarters(lineup.starters)
        setBench(lineup.bench)
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

    async function handleTap(newSel: Selection) {
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
        Alert.alert(
            'Auto-Set Lineup',
            'Optimize for today or the entire week?',
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Today', onPress: () => doAutoSet(selectedDate) },
                { text: 'Full Week', onPress: () => doAutoSet(null) },
            ],
        )
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
        return (
            <SafeAreaView style={styles.container}>
                <ActivityIndicator style={{ flex: 1 }} color="#F97316" />
            </SafeAreaView>
        )
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
                        <ActivityIndicator size="small" color="#F97316" />
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
                                        <View
                                            style={[
                                                styles.avatar,
                                                { backgroundColor: POSITION_COLORS[p.position ?? ''] ?? '#ccc' },
                                            ]}
                                        >
                                            <Text style={styles.avatarText}>
                                                {p.displayName
                                                    .split(' ')
                                                    .map((w) => w[0])
                                                    .slice(0, 2)
                                                    .join('')}
                                            </Text>
                                        </View>
                                        <View style={styles.playerInfo}>
                                            <Text style={styles.playerName}>{p.displayName}</Text>
                                            <Text style={styles.playerMeta}>
                                                {[p.nbaTeam, p.position].filter(Boolean).join(' · ')}
                                            </Text>
                                        </View>
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
                                    <View
                                        style={[
                                            styles.avatar,
                                            { backgroundColor: POSITION_COLORS[player.position ?? ''] ?? '#ccc' },
                                        ]}
                                    >
                                        <Text style={styles.avatarText}>
                                            {player.displayName
                                                .split(' ')
                                                .map((w) => w[0])
                                                .slice(0, 2)
                                                .join('')}
                                        </Text>
                                    </View>
                                    <View style={styles.playerInfo}>
                                        <Text style={styles.playerName}>{player.displayName}</Text>
                                        <Text style={styles.playerMeta}>
                                            {[player.nbaTeam, player.position].filter(Boolean).join(' · ')}
                                        </Text>
                                    </View>
                                </Pressable>
                            )
                        })
                    )}
                </View>
            </ScrollView>

            {saving && (
                <View style={styles.savingOverlay}>
                    <ActivityIndicator color="#F97316" />
                </View>
            )}
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
        backgroundColor: '#fff',
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    closeButton: { minWidth: 48 },
    closeText: { fontSize: 15, fontWeight: '600', color: '#F97316' },
    headerTitle: { flex: 1, fontSize: 18, fontWeight: '800', textAlign: 'center' },
    autoSetButton: {
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 20,
        borderCurve: 'continuous' as const,
        borderWidth: 1.5,
        borderColor: '#F97316',
        minWidth: 80,
        alignItems: 'center',
    },
    autoSetText: { fontSize: 13, fontWeight: '700', color: '#F97316' },

    daySelectorRow: { borderBottomWidth: 1, borderBottomColor: '#eee' },
    daySelectorContent: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8, gap: 6 },
    dayCell: { width: 38, alignItems: 'center', paddingVertical: 5, borderRadius: 9, borderCurve: 'continuous' as const, gap: 2 },
    dayCellSelected: { backgroundColor: '#F97316' },
    dayCellToday: { backgroundColor: '#FFF7ED' },
    dayCellNoGames: { opacity: 0.4 },
    dayLabel: { fontSize: 10, fontWeight: '700', color: '#888' },
    dayLabelSelected: { color: '#fff' },
    dayNum: { fontSize: 14, fontWeight: '800', color: '#111' },
    dayNumSelected: { color: '#fff' },
    gameDot: { width: 4, height: 4, borderRadius: 2, borderCurve: 'continuous' as const, backgroundColor: '#F97316', marginTop: 1 },
    gameDotSelected: { backgroundColor: 'rgba(255,255,255,0.7)' },

    hint: {
        backgroundColor: '#FFF7ED',
        borderBottomWidth: 1,
        borderBottomColor: '#FED7AA',
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    hintText: { fontSize: 13, color: '#C2410C', fontWeight: '500' },

    scroll: { padding: 16, gap: 8 },

    sectionLabel: {
        fontSize: 11,
        fontWeight: '700',
        color: '#aaa',
        letterSpacing: 0.5,
        marginBottom: 4,
        marginLeft: 4,
    },

    card: {
        backgroundColor: '#fff',
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: '#eee',
        marginBottom: 12,
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
    divider: { borderTopWidth: 1, borderTopColor: '#f3f3f3' },
    selectedRow: { backgroundColor: '#FFF7ED' },

    slotLabel: {
        width: 36,
        fontSize: 11,
        fontWeight: '800',
        color: '#aaa',
        letterSpacing: 0.3,
    },

    avatar: {
        width: 36,
        height: 36,
        borderRadius: 18,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    avatarText: { color: '#fff', fontWeight: '700', fontSize: 12 },

    playerInfo: { flex: 1, gap: 1 },
    playerName: { fontSize: 15, fontWeight: '600', color: '#111' },
    playerMeta: { fontSize: 12, color: '#888' },

    emptySlot: { fontSize: 14, color: '#ccc', fontStyle: 'italic' },
    benchEmpty: { padding: 16, fontSize: 13, color: '#aaa', textAlign: 'center' },

    empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    emptyText: { fontSize: 14, color: '#aaa' },

    savingOverlay: {
        position: 'absolute',
        bottom: 24,
        alignSelf: 'center',
        backgroundColor: 'rgba(0,0,0,0.6)',
        borderRadius: 20,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 20,
        paddingVertical: 10,
    },
})
