import {
    View,
    Text,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    ScrollView,
    Modal,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useCallback, useEffect } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { Scoreboard } from '@/components/Scoreboard'
import { LineupSlot, LineupPlayer } from '@/lib/lineup'
import { LiveStatLine } from '@/lib/games'
import { isIREligible } from '@/lib/roster'
import { colors, palette } from '@/constants/tokens'
import { LoadingScreen } from '@/components/LoadingScreen'
import { DaySelector } from '@/components/DaySelector'
import { ScoreCard } from '@/components/ScoreCard'
import { NoLeagueState } from '@/components/NoLeagueState'
import { AutoSetModal } from '@/components/AutoSetModal'
import { MatchupRow } from '@/components/MatchupRow'
import { useMatchupData } from '@/hooks/use-matchup-data'
import { useLiveStats } from '@/hooks/use-live-stats'
import { useLineupActions } from '@/hooks/use-lineup-actions'

type LineupData = { starters: LineupSlot[]; bench: LineupPlayer[]; ir: LineupPlayer[] }
type Sel = { kind: 'starter'; index: number } | { kind: 'bench'; index: number } | { kind: 'ir'; index: number }

function shortName(name: string): string {
    const parts = name.trim().split(' ')
    if (parts.length <= 1) return name
    return `${parts[0][0]}. ${parts.slice(1).join(' ')}`
}

export default function HomeScreen() {
    const { memberships, current, setCurrent, loading } = useLeagueContext()
    const { user } = useAuth()
    const league = (current as any)?.leagues

    const {
        matchup, weekDays, selectedDate, setSelectedDate,
        myLineup, oppLineup, matchupLoading, lineupLoading,
        loadMyLineup, loadLineups, matchupRef,
    } = useMatchupData(current, user, league)

    const refreshLineup = useCallback(() => {
        if (matchupRef.current) loadLineups(matchupRef.current, selectedDate).catch(() => {})
    }, [matchupRef, loadLineups, selectedDate])

    const { todaysGames, liveStats, startedTeams, liveTeams, teamMatchups } = useLiveStats(selectedDate, refreshLineup)

    const {
        selected, setSelected, saving, autoSetting,
        autoSetModalVisible, setAutoSetModalVisible,
        irOverflowPending, setIROverflowPending, irOverflowSaving,
        handleTap, handleIROverflowDrop, handleIROverflowMoveToIR,
        doAutoSet, handleAutoSet,
    } = useLineupActions({ matchup, myLineup, league, selectedDate, startedTeams, loadMyLineup })

    // Clear selection whenever lineup reloads (tab focus / league change)
    useEffect(() => {
        if (matchupLoading) setSelected(null)
    }, [matchupLoading, setSelected])

    async function handleDaySelect(date: string) {
        if (!matchupRef.current) return
        setSelectedDate(date)
        setSelected(null)
        await loadLineups(matchupRef.current, date)
    }

    const todayPlayingTeams = new Set(weekDays.find((d) => d.date === selectedDate)?.playingTeams ?? [])

    const myTeamSet = new Set<string>(
        myLineup
            ? [
                ...myLineup.starters.map((s) => s.player?.nbaTeam),
                ...myLineup.bench.map((p) => p.nbaTeam),
                ...myLineup.ir.map((p) => p.nbaTeam),
              ].filter(Boolean) as string[]
            : [],
    )

    const selectedPlayer = myLineup && selected
        ? selected.kind === 'starter' ? myLineup.starters[selected.index]?.player
        : selected.kind === 'bench' ? myLineup.bench[selected.index]
        : myLineup.ir[selected.index]
        : null

    if (loading) return <LoadingScreen />
    if (memberships.length === 0) return <NoLeagueState />

    return (
        <SafeAreaView style={styles.container}>
            {memberships.length > 1 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.switcherRow} contentContainerStyle={styles.switcherContent}>
                    {memberships.map((m) => {
                        const ma = m as any
                        const isActive = ma.id === (current as any)?.id
                        return (
                            <Pressable key={ma.id} style={[styles.switcherChip, isActive && styles.switcherChipActive]} onPress={() => setCurrent(m)}>
                                <Text style={[styles.switcherText, isActive && styles.switcherTextActive]}>{ma.leagues?.name ?? 'League'}</Text>
                            </Pressable>
                        )
                    })}
                </ScrollView>
            )}

            <Scoreboard games={todaysGames} myTeamSet={myTeamSet} />

            {matchupLoading ? (
                <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
            ) : matchup ? (
                <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
                    <ScoreCard matchup={matchup} />

                    {weekDays.length > 0 && (
                        <DaySelector days={weekDays} selectedDate={selectedDate} onSelect={handleDaySelect} />
                    )}

                    {/* Auto-set button */}
                    <View style={styles.lineupHeader}>
                        <Pressable
                            style={styles.autoSetBtn}
                            onPress={handleAutoSet}
                            disabled={autoSetting || saving}
                        >
                            {autoSetting
                                ? <ActivityIndicator size="small" color={colors.primary} />
                                : <Text style={styles.autoSetText}>AUTO</Text>}
                        </Pressable>
                    </View>

                    {/* Selection hint */}
                    {selected && (
                        <View style={styles.hint}>
                            <Text style={styles.hintText}>
                                {selectedPlayer
                                    ? `${shortName(selectedPlayer.displayName)} selected — tap another slot to swap`
                                    : `Empty slot selected — tap a player's slot to fill it`}
                            </Text>
                            <Pressable onPress={() => setSelected(null)}>
                                <Text style={styles.hintCancel}>Cancel</Text>
                            </Pressable>
                        </View>
                    )}

                    {lineupLoading ? (
                        <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
                    ) : myLineup && oppLineup ? (
                        <MatchupLineupView
                            myLineup={myLineup}
                            oppLineup={oppLineup}
                            selected={selected}
                            onTap={handleTap}
                            saving={saving}
                            playingTeams={todayPlayingTeams}
                            liveStats={liveStats}
                            liveTeams={liveTeams}
                            scoringSettings={league?.scoring_settings ?? {}}
                            teamMatchups={teamMatchups}
                        />
                    ) : (
                        <View style={styles.noLineup}>
                            <Text style={styles.noLineupText}>No lineup set for this day.</Text>
                            <Pressable style={styles.setLineupBtn} onPress={handleAutoSet} disabled={autoSetting}>
                                <Text style={styles.setLineupBtnText}>Auto-Set Lineup</Text>
                            </Pressable>
                        </View>
                    )}
                </ScrollView>
            ) : (
                <View style={styles.noMatchup}>
                    <Text style={styles.noMatchupText}>No matchup this week yet.</Text>
                    <Text style={styles.noMatchupSub}>Matchups are generated before each week starts.</Text>
                </View>
            )}

            {/* IR overflow modal */}
            <Modal
                visible={irOverflowPending !== null}
                transparent
                animationType="slide"
                onRequestClose={() => setIROverflowPending(null)}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.modalSheet}>
                        <Text style={styles.modalTitle}>Active Roster Full</Text>
                        <Text style={styles.modalSub}>
                            Drop a player or move one to IR to make room.
                        </Text>
                        <ScrollView style={{ maxHeight: 360 }}>
                            {myLineup && [...myLineup.starters.filter(s => s.player).map(s => s.player!), ...myLineup.bench].map((p) => (
                                <View key={p.rosterPlayerId} style={styles.overflowRow}>
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.overflowName} numberOfLines={1}>{p.displayName}</Text>
                                        <Text style={styles.overflowMeta}>{p.nbaTeam ?? 'FA'}{p.position ? ` · ${p.position}` : ''}</Text>
                                    </View>
                                    {isIREligible(p.injuryStatus) && (
                                        <Pressable
                                            style={[styles.overflowBtn, { backgroundColor: palette.red900 + '22', marginRight: 6 }]}
                                            onPress={() => handleIROverflowMoveToIR(p.rosterPlayerId)}
                                            disabled={irOverflowSaving}
                                        >
                                            <Text style={[styles.overflowBtnText, { color: palette.red900 }]}>→ IR</Text>
                                        </Pressable>
                                    )}
                                    <Pressable
                                        style={[styles.overflowBtn, { backgroundColor: colors.danger + '22' }]}
                                        onPress={() => handleIROverflowDrop(p.rosterPlayerId)}
                                        disabled={irOverflowSaving}
                                    >
                                        <Text style={[styles.overflowBtnText, { color: colors.danger }]}>Drop</Text>
                                    </Pressable>
                                </View>
                            ))}
                        </ScrollView>
                        <Pressable style={styles.modalCancel} onPress={() => setIROverflowPending(null)}>
                            <Text style={styles.modalCancelText}>Cancel</Text>
                        </Pressable>
                    </View>
                </View>
            </Modal>

            <AutoSetModal
                visible={autoSetModalVisible}
                onClose={() => setAutoSetModalVisible(false)}
                onToday={() => { setAutoSetModalVisible(false); doAutoSet(selectedDate) }}
                onWholeWeek={() => { setAutoSetModalVisible(false); doAutoSet(null) }}
            />
        </SafeAreaView>
    )
}

// ── Matchup lineup (both teams side by side) ───────────────────

function MatchupLineupView({
    myLineup,
    oppLineup,
    selected,
    onTap,
    saving,
    playingTeams,
    liveStats,
    liveTeams,
    scoringSettings,
    teamMatchups,
}: {
    myLineup: LineupData
    oppLineup: LineupData
    selected: Sel | null
    onTap: (sel: Sel) => void
    saving: boolean
    playingTeams: Set<string>
    liveStats: Map<string, LiveStatLine>
    liveTeams: Set<string>
    scoringSettings: Record<string, number>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
}) {
    const maxBench = Math.max(myLineup.bench.length, oppLineup.bench.length)
    const maxIR = Math.max(myLineup.ir.length, oppLineup.ir.length)

    return (
        <View style={styles.lineupContainer}>
            {/* Starters */}
            {myLineup.starters.map((slot, i) => (
                <MatchupRow
                    key={`s${i}`}
                    myPlayer={slot.player}
                    oppPlayer={oppLineup.starters[i]?.player ?? null}
                    slotType={slot.slotType}
                    selKind="starter"
                    selIndex={i}
                    selected={selected}
                    onTap={onTap}
                    saving={saving}
                    playingTeams={playingTeams}
                    liveStats={liveStats}
                    liveTeams={liveTeams}
                    scoringSettings={scoringSettings}
                    teamMatchups={teamMatchups}
                />
            ))}

            {maxBench > 0 && (
                <>
                    <SectionDivider label="BENCH" />
                    {Array.from({ length: maxBench }, (_, i) => (
                        <MatchupRow
                            key={`b${i}`}
                            myPlayer={myLineup.bench[i] ?? null}
                            oppPlayer={oppLineup.bench[i] ?? null}
                            slotType="BE"
                            selKind="bench"
                            selIndex={i}
                            selected={selected}
                            onTap={onTap}
                            saving={saving}
                            playingTeams={playingTeams}
                            liveStats={liveStats}
                            liveTeams={liveTeams}
                            scoringSettings={scoringSettings}
                            teamMatchups={teamMatchups}
                            isExtraOppRow={i >= myLineup.bench.length}
                        />
                    ))}
                </>
            )}

            {maxIR > 0 && (
                <>
                    <SectionDivider label="INJURED RESERVE" color={colors.danger} />
                    {Array.from({ length: maxIR }, (_, i) => (
                        <MatchupRow
                            key={`ir${i}`}
                            myPlayer={myLineup.ir[i] ?? null}
                            oppPlayer={oppLineup.ir[i] ?? null}
                            slotType="IR"
                            selKind="ir"
                            selIndex={i}
                            selected={selected}
                            onTap={onTap}
                            saving={saving}
                            playingTeams={playingTeams}
                            liveStats={liveStats}
                            liveTeams={liveTeams}
                            scoringSettings={scoringSettings}
                            teamMatchups={teamMatchups}
                        />
                    ))}
                </>
            )}
        </View>
    )
}

function SectionDivider({ label, color = palette.gray550 }: { label: string; color?: string }) {
    return (
        <View style={styles.dividerRow}>
            <Text style={[styles.dividerText, { color }]}>{label}</Text>
        </View>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },

    switcherRow: { maxHeight: 48, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
    switcherContent: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8, paddingVertical: 8 },
    switcherChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, borderCurve: 'continuous' as const, backgroundColor: colors.bgMuted },
    switcherChipActive: { backgroundColor: colors.primary },
    switcherText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
    switcherTextActive: { color: colors.textWhite },

    scrollContent: { paddingTop: 28, paddingBottom: 40 },

    // Lineup header
    lineupHeader: { alignItems: 'center', paddingTop: 12, paddingBottom: 4 },
    autoSetBtn: {
        height: 28,
        paddingHorizontal: 16,
        borderRadius: 8,
        borderCurve: 'continuous' as const,
        borderWidth: 1.5,
        borderColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    autoSetText: { fontSize: 11, fontWeight: '800', color: colors.primary, letterSpacing: 0.5 },

    // Selection hint
    hint: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.primaryLight,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: colors.primaryBorder,
        paddingHorizontal: 16,
        paddingVertical: 9,
        marginTop: 4,
    },
    hintText: { flex: 1, fontSize: 13, color: colors.primaryDark, fontWeight: '500' },
    hintCancel: { fontSize: 13, fontWeight: '700', color: colors.primary, paddingLeft: 12 },

    lineupContainer: { paddingHorizontal: 16 },
    dividerRow: { paddingTop: 12, paddingBottom: 3 },
    dividerText: { fontSize: 10, fontWeight: '800', color: palette.gray550, letterSpacing: 0.8 },

    noLineup: { padding: 32, alignItems: 'center', gap: 12 },
    noLineupText: { fontSize: 14, color: colors.textPlaceholder, textAlign: 'center' },
    setLineupBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, borderCurve: 'continuous' as const, backgroundColor: colors.primary },
    setLineupBtnText: { color: colors.textWhite, fontWeight: '700', fontSize: 14 },

    noMatchup: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8, padding: 32 },
    noMatchupText: { fontSize: 16, fontWeight: '600', color: colors.textSecondary },
    noMatchupSub: { fontSize: 13, color: colors.textPlaceholder, textAlign: 'center' },

    // IR overflow modal
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
    modalSheet: { backgroundColor: colors.bgScreen, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, gap: 12 },
    modalTitle: { fontSize: 17, fontWeight: '800', color: colors.textPrimary },
    modalSub: { fontSize: 13, color: colors.textMuted, marginBottom: 4 },
    overflowRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.separator, gap: 8 },
    overflowName: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
    overflowMeta: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
    overflowBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
    overflowBtnText: { fontSize: 12, fontWeight: '700' },
    modalCancel: { paddingVertical: 14, alignItems: 'center' },
    modalCancelText: { fontSize: 15, fontWeight: '600', color: colors.textMuted },
})
