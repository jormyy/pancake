import {
    View,
    Text,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    ScrollView,
    Alert,
    Modal,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { getMyMatchup, Matchup } from '@/lib/scoring'
import {
    getWeekDays,
    getWeeklyLineup,
    setPlayerSlot,
    autoSetLineup,
    canPlaySlot,
    LineupSlot,
    LineupPlayer,
    WeekDay,
} from '@/lib/lineup'
import { POSITION_COLORS } from '@/constants/positions'
import { toggleIR, dropPlayer } from '@/lib/roster'

type LineupData = { starters: LineupSlot[]; bench: LineupPlayer[]; ir: LineupPlayer[] }
type Sel = { kind: 'starter'; index: number } | { kind: 'bench'; index: number } | { kind: 'ir'; index: number }

// Pending IR activate — held while user resolves roster overflow
type PendingIRActivate = { rosterPlayerId: string }

function isIREligible(status: string | null): boolean {
    if (!status) return false
    const s = status.toLowerCase()
    return s === 'out' || s.startsWith('ir')
}

const SLOT_W = 52

function shortName(name: string): string {
    const parts = name.trim().split(' ')
    if (parts.length <= 1) return name
    return `${parts[0][0]}. ${parts.slice(1).join(' ')}`
}

export default function HomeScreen() {
    const { push } = useRouter()
    const { memberships, current, setCurrent, loading } = useLeagueContext()
    const { user } = useAuth()

    const [matchup, setMatchup] = useState<Matchup | null | undefined>(undefined)
    const [weekDays, setWeekDays] = useState<WeekDay[]>([])
    const [selectedDate, setSelectedDate] = useState<string>(
        () => new Date().toISOString().split('T')[0],
    )
    const [myLineup, setMyLineup] = useState<LineupData | null>(null)
    const [oppLineup, setOppLineup] = useState<LineupData | null>(null)
    const [matchupLoading, setMatchupLoading] = useState(true)
    const [lineupLoading, setLineupLoading] = useState(false)

    const [selected, setSelected] = useState<Sel | null>(null)
    const [saving, setSaving] = useState(false)
    const [autoSetting, setAutoSetting] = useState(false)

    const [irOverflowPending, setIROverflowPending] = useState<PendingIRActivate | null>(null)
    const [irOverflowSaving, setIROverflowSaving] = useState(false)

    const matchupRef = useRef<Matchup | null>(null)
    const league = (current as any)?.leagues

    const loadLineups = useCallback(
        async (m: Matchup, date: string) => {
            setLineupLoading(true)
            try {
                const [mine, opp] = await Promise.all([
                    getWeeklyLineup(m.myMemberId, league?.id, m.seasonId, m.weekNumber, date),
                    getWeeklyLineup(m.opponentMemberId, league?.id, m.seasonId, m.weekNumber, date),
                ])
                setMyLineup(mine)
                setOppLineup(opp)
            } finally {
                setLineupLoading(false)
            }
        },
        [league?.id],
    )

    const loadMyLineup = useCallback(
        async (m: Matchup, date: string) => {
            const data = await getWeeklyLineup(m.myMemberId, league?.id, m.seasonId, m.weekNumber, date)
            setMyLineup(data)
        },
        [league?.id],
    )

    const load = useCallback(async () => {
        if (!current || !user) return
        setMatchupLoading(true)
        setMyLineup(null)
        setOppLineup(null)
        setSelected(null)
        try {
            const m = await getMyMatchup((current as any).id, league.id)
            setMatchup(m)
            matchupRef.current = m
            if (m) {
                const today = new Date().toISOString().split('T')[0]
                const days = await getWeekDays(m.weekNumber, m.seasonYear)
                setWeekDays(days)
                setSelectedDate(today)
                await loadLineups(m, today)
            }
        } catch (e) {
            console.error(e)
            setMatchup(null)
        } finally {
            setMatchupLoading(false)
        }
    }, [current, user, loadLineups])

    useFocusEffect(useCallback(() => { load() }, [load]))

    async function handleDaySelect(date: string) {
        if (!matchupRef.current) return
        setSelectedDate(date)
        setSelected(null)
        await loadLineups(matchupRef.current, date)
    }

    async function handleTap(newSel: Sel) {
        if (!selected) { setSelected(newSel); return }
        if (selected.kind === newSel.kind && selected.index === newSel.index) {
            setSelected(null); return
        }
        setSelected(null)
        if (!matchup || !myLineup) return

        const starters = myLineup.starters
        const bench = myLineup.bench
        const ir = myLineup.ir

        const getPlayer = (s: Sel): LineupPlayer | null =>
            s.kind === 'starter' ? starters[s.index]?.player ?? null
            : s.kind === 'bench' ? bench[s.index] ?? null
            : ir[s.index] ?? null
        const getSlot = (s: Sel): string =>
            s.kind === 'starter' ? starters[s.index]?.slotType ?? 'BE'
            : s.kind === 'bench' ? 'BE'
            : 'IR'

        const aPlayer = getPlayer(selected)
        const bPlayer = getPlayer(newSel)
        const aSlot = getSlot(selected)
        const bSlot = getSlot(newSel)

        // ── IR swap branch ──────────────────────────────────────
        if (aSlot === 'IR' || bSlot === 'IR') {
            const irSel   = aSlot === 'IR' ? selected : newSel
            const actSel  = aSlot === 'IR' ? newSel   : selected
            const irPlayer  = getPlayer(irSel)
            const actPlayer = getPlayer(actSel)

            // Active player going to IR must be IR-eligible
            if (actPlayer && !isIREligible(actPlayer.injuryStatus)) {
                Alert.alert('Not eligible', `${actPlayer.displayName} must be OUT or IR-designated to be placed on Injured Reserve.`)
                return
            }

            // Activating an IR player with no exchange → check overflow
            if (irPlayer && !actPlayer) {
                const rosterSize: number = league?.roster_size ?? 20
                const activeCount = starters.filter(s => s.player !== null).length + bench.length
                if (activeCount >= rosterSize) {
                    setIROverflowPending({ rosterPlayerId: irPlayer.rosterPlayerId })
                    return
                }
            }

            setSaving(true)
            try {
                if (actPlayer) await toggleIR(actPlayer.rosterPlayerId, true)
                if (irPlayer) {
                    await toggleIR(irPlayer.rosterPlayerId, false)
                    // If being moved into a starter slot, assign it
                    if (actSel.kind === 'starter') {
                        const slotType = starters[actSel.index]?.slotType
                        if (slotType && canPlaySlot(irPlayer.position, slotType)) {
                            await setPlayerSlot(matchup.myMemberId, league.id, matchup.seasonId, matchup.weekNumber, selectedDate, irPlayer.playerId, slotType)
                        }
                    }
                }
                await loadMyLineup(matchup, selectedDate)
            } catch (e: any) {
                Alert.alert('Error', e.message)
            } finally {
                setSaving(false)
            }
            return
        }

        // ── Regular (non-IR) swap ───────────────────────────────
        if (aPlayer && bSlot !== 'BE' && !canPlaySlot(aPlayer.position, bSlot)) {
            Alert.alert('Invalid move', `${aPlayer.displayName} can't play ${bSlot}`); return
        }
        if (bPlayer && aSlot !== 'BE' && !canPlaySlot(bPlayer.position, aSlot)) {
            Alert.alert('Invalid move', `${bPlayer.displayName} can't play ${aSlot}`); return
        }

        setSaving(true)
        try {
            const saves: Promise<void>[] = []
            if (aPlayer) saves.push(setPlayerSlot(matchup.myMemberId, league.id, matchup.seasonId, matchup.weekNumber, selectedDate, aPlayer.playerId, bSlot))
            if (bPlayer) saves.push(setPlayerSlot(matchup.myMemberId, league.id, matchup.seasonId, matchup.weekNumber, selectedDate, bPlayer.playerId, aSlot))
            await Promise.all(saves)
            await loadMyLineup(matchup, selectedDate)
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setSaving(false)
        }
    }

    async function handleIROverflowDrop(dropRosterPlayerId: string) {
        if (!irOverflowPending || !matchup) return
        setIROverflowSaving(true)
        try {
            await dropPlayer(dropRosterPlayerId)
            await toggleIR(irOverflowPending.rosterPlayerId, false)
            setIROverflowPending(null)
            await loadMyLineup(matchup, selectedDate)
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setIROverflowSaving(false)
        }
    }

    async function handleIROverflowMoveToIR(moveRosterPlayerId: string) {
        if (!irOverflowPending || !matchup) return
        setIROverflowSaving(true)
        try {
            await toggleIR(moveRosterPlayerId, true)
            await toggleIR(irOverflowPending.rosterPlayerId, false)
            setIROverflowPending(null)
            await loadMyLineup(matchup, selectedDate)
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setIROverflowSaving(false)
        }
    }

    async function doAutoSet(date: string | null) {
        if (!matchup) return
        setAutoSetting(true)
        try {
            await autoSetLineup(
                matchup.myMemberId, league.id, matchup.seasonId,
                matchup.weekNumber, matchup.seasonYear, date,
            )
            await loadMyLineup(matchup, selectedDate)
        } catch (e: any) {
            Alert.alert('Auto-set failed', e.message)
        } finally {
            setAutoSetting(false)
        }
    }

    function handleAutoSet() {
        Alert.alert(
            'Auto-Set Lineup',
            'Optimize for today or every day this week?',
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Today', onPress: () => doAutoSet(selectedDate) },
                { text: 'Full Week', onPress: () => doAutoSet(null) },
            ],
        )
    }

    const todayPlayingTeams = new Set(
        weekDays.find((d) => d.date === selectedDate)?.playingTeams ?? [],
    )

    const selectedPlayer = myLineup && selected
        ? selected.kind === 'starter' ? myLineup.starters[selected.index]?.player
        : selected.kind === 'bench' ? myLineup.bench[selected.index]
        : myLineup.ir[selected.index]
        : null

    if (loading) {
        return <SafeAreaView style={styles.container}><ActivityIndicator style={{ flex: 1 }} color="#F97316" /></SafeAreaView>
    }

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

            {matchupLoading ? (
                <ActivityIndicator color="#F97316" style={{ marginTop: 48 }} />
            ) : matchup ? (
                <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
                    <ScoreCard matchup={matchup} />

                    {weekDays.length > 0 && (
                        <DaySelector days={weekDays} selectedDate={selectedDate} onSelect={handleDaySelect} />
                    )}

                    {/* Team names header + auto-set */}
                    <View style={styles.lineupHeader}>
                        <Text style={[styles.lineupTeamName, { textAlign: 'right' }]} numberOfLines={1}>
                            {matchup.myTeamName}
                        </Text>
                        <Pressable
                            style={[styles.autoSetBtn, { width: SLOT_W }]}
                            onPress={handleAutoSet}
                            disabled={autoSetting || saving}
                        >
                            {autoSetting
                                ? <ActivityIndicator size="small" color="#F97316" />
                                : <Text style={styles.autoSetText}>AUTO</Text>}
                        </Pressable>
                        <Text style={styles.lineupTeamName} numberOfLines={1}>
                            {matchup.opponentTeamName}
                        </Text>
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
                        <ActivityIndicator color="#F97316" style={{ marginTop: 24 }} />
                    ) : myLineup && oppLineup ? (
                        <MatchupLineupView
                            myLineup={myLineup}
                            oppLineup={oppLineup}
                            selected={selected}
                            onTap={handleTap}
                            saving={saving}
                            playingTeams={todayPlayingTeams}
                        />
                    ) : (
                        <View style={styles.noLineup}>
                            <Text style={styles.noLineupText}>No lineup set for this day.</Text>
                            <Pressable style={styles.setLineupBtn} onPress={() => doAutoSet(selectedDate)} disabled={autoSetting}>
                                <Text style={styles.setLineupBtnText}>Auto-Set Today</Text>
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
                                            style={[styles.overflowBtn, { backgroundColor: '#991B1B22', marginRight: 6 }]}
                                            onPress={() => handleIROverflowMoveToIR(p.rosterPlayerId)}
                                            disabled={irOverflowSaving}
                                        >
                                            <Text style={[styles.overflowBtnText, { color: '#991B1B' }]}>→ IR</Text>
                                        </Pressable>
                                    )}
                                    <Pressable
                                        style={[styles.overflowBtn, { backgroundColor: '#EF444422' }]}
                                        onPress={() => handleIROverflowDrop(p.rosterPlayerId)}
                                        disabled={irOverflowSaving}
                                    >
                                        <Text style={[styles.overflowBtnText, { color: '#EF4444' }]}>Drop</Text>
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
}: {
    myLineup: LineupData
    oppLineup: LineupData
    selected: Sel | null
    onTap: (sel: Sel) => void
    saving: boolean
    playingTeams: Set<string>
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
                        />
                    ))}
                </>
            )}

            {maxIR > 0 && (
                <>
                    <SectionDivider label="INJURED RESERVE" color="#EF4444" />
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
                        />
                    ))}
                </>
            )}
        </View>
    )
}

function MatchupRow({
    myPlayer,
    oppPlayer,
    slotType,
    selKind,
    selIndex,
    selected,
    onTap,
    saving,
    playingTeams,
}: {
    myPlayer: LineupPlayer | null
    oppPlayer: LineupPlayer | null
    slotType: string
    selKind: 'starter' | 'bench' | 'ir'
    selIndex: number
    selected: Sel | null
    onTap: (sel: Sel) => void
    saving: boolean
    playingTeams: Set<string>
}) {
    const isSel = selected?.kind === selKind && selected.index === selIndex
    const slotColor = slotType === 'IR' ? '#EF4444' : (POSITION_COLORS[slotType] ?? '#aaa')
    const myHasGame = myPlayer?.nbaTeam ? playingTeams.has(myPlayer.nbaTeam) : false
    const oppHasGame = oppPlayer?.nbaTeam ? playingTeams.has(oppPlayer.nbaTeam) : false

    return (
        <View style={styles.matchupRow}>
            {/* Left: my player (right-aligned) */}
            <Pressable
                style={styles.rowSideLeft}
                onPress={myPlayer ? () => push(`/player/${myPlayer.playerId}` as any) : undefined}
                disabled={!myPlayer}
            >
                {myPlayer ? (
                    <>
                        <View style={[styles.metaRow, { justifyContent: 'flex-end' }]}>
                            <InjuryBadge status={myPlayer.injuryStatus} />
                            <Text style={[styles.sideName, !myHasGame && styles.noGameName]} numberOfLines={1}>
                                {shortName(myPlayer.displayName)}
                            </Text>
                        </View>
                        <View style={[styles.metaRow, { justifyContent: 'flex-end' }]}>
                            {myPlayer.position && <PosTag position={myPlayer.position} />}
                            <Text style={styles.sideMeta} numberOfLines={1}>
                                {myPlayer.nbaTeam ?? 'FA'}{!myHasGame ? ' · No game' : ''}
                            </Text>
                        </View>
                    </>
                ) : (
                    <Text style={[styles.sideName, { color: '#ddd', textAlign: 'right' }]}>—</Text>
                )}
            </Pressable>

            {/* Center: slot chip */}
            <Pressable
                style={[
                    styles.slotChipCenter,
                    { backgroundColor: slotColor + '22' },
                    isSel && styles.slotChipSelected,
                ]}
                onPress={() => onTap({ kind: selKind, index: selIndex })}
                disabled={saving}
                activeOpacity={0.7}
            >
                <Text style={[styles.slotChipText, { color: isSel ? '#F97316' : slotColor }]}>
                    {slotType}
                </Text>
            </Pressable>

            {/* Right: opponent player (left-aligned) */}
            <Pressable
                style={styles.rowSideRight}
                onPress={oppPlayer ? () => push(`/player/${oppPlayer.playerId}` as any) : undefined}
                disabled={!oppPlayer}
            >
                {oppPlayer ? (
                    <>
                        <View style={styles.metaRow}>
                            <Text style={[styles.sideName, !oppHasGame && styles.noGameName]} numberOfLines={1}>
                                {shortName(oppPlayer.displayName)}
                            </Text>
                            <InjuryBadge status={oppPlayer.injuryStatus} />
                        </View>
                        <View style={styles.metaRow}>
                            {oppPlayer.position && <PosTag position={oppPlayer.position} />}
                            <Text style={styles.sideMeta} numberOfLines={1}>
                                {oppPlayer.nbaTeam ?? 'FA'}{!oppHasGame ? ' · No game' : ''}
                            </Text>
                        </View>
                    </>
                ) : (
                    <Text style={[styles.sideName, { color: '#ddd' }]}>—</Text>
                )}
            </Pressable>
        </View>
    )
}

function PosTag({ position }: { position: string }) {
    const color = POSITION_COLORS[position] ?? '#ccc'
    return (
        <View style={[styles.posTag, { backgroundColor: color + '22' }]}>
            <Text style={[styles.posTagText, { color }]}>{position}</Text>
        </View>
    )
}

function InjuryBadge({ status }: { status: string | null }) {
    if (!status) return null
    const s = status.toLowerCase()
    let label = status.toUpperCase()
    let color = '#aaa'
    if (s === 'out') { color = '#EF4444'; label = 'OUT' }
    else if (s.startsWith('ir')) { color = '#991B1B'; label = 'IR' }
    else if (s === 'gtd' || s === 'game time decision') { color = '#D97706'; label = 'GTD' }
    else if (s === 'd-td' || s === 'day-to-day') { color = '#F97316'; label = 'D-TD' }
    else return null

    return (
        <View style={[styles.injuryBadge, { backgroundColor: color + '22' }]}>
            <Text style={[styles.injuryBadgeText, { color }]}>{label}</Text>
        </View>
    )
}

function SectionDivider({ label, color = '#bbb' }: { label: string; color?: string }) {
    return (
        <View style={styles.dividerRow}>
            <Text style={[styles.dividerText, { color }]}>{label}</Text>
        </View>
    )
}

// ── Day selector ───────────────────────────────────────────────

function DaySelector({ days, selectedDate, onSelect }: { days: WeekDay[]; selectedDate: string; onSelect: (date: string) => void }) {
    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.daySelectorRow}
            contentContainerStyle={styles.daySelectorContent}
        >
            {days.map((day) => {
                const isSelected = day.date === selectedDate
                return (
                    <Pressable
                        key={day.date}
                        style={[
                            styles.dayCell,
                            isSelected && styles.dayCellSelected,
                            day.isToday && !isSelected && styles.dayCellToday,
                            !day.hasGames && styles.dayCellNoGames,
                        ]}
                        onPress={() => onSelect(day.date)}
                    >
                        <Text style={[styles.dayLabel, isSelected && styles.dayLabelSelected, !day.hasGames && styles.dayLabelFaint]}>
                            {day.dayLabel}
                        </Text>
                        <Text style={[styles.dayNum, isSelected && styles.dayNumSelected, !day.hasGames && styles.dayNumFaint]}>
                            {day.dateNum}
                        </Text>
                        {day.hasGames && <View style={[styles.gameDot, isSelected && styles.gameDotSelected]} />}
                    </Pressable>
                )
            })}
        </ScrollView>
    )
}

// ── Score card ─────────────────────────────────────────────────

function ScoreCard({ matchup }: { matchup: Matchup }) {
    const fmt = (n: number | null) => (n != null ? n.toFixed(1) : '—')
    const myPts = matchup.myPoints ?? 0
    const oppPts = matchup.opponentPoints ?? 0
    const iWinning = myPts > oppPts

    let statusLabel = 'In Progress'
    let statusColor = '#F97316'
    if (matchup.isFinalized) {
        statusLabel = matchup.iWon ? 'Win' : 'Loss'
        statusColor = matchup.iWon ? '#10B981' : '#EF4444'
    }

    return (
        <View style={styles.matchupCard}>
            <View style={styles.matchupHeader}>
                <Text style={styles.matchupWeek}>Week {matchup.weekNumber}</Text>
                <View style={[styles.statusBadge, { backgroundColor: statusColor + '22' }]}>
                    <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
                </View>
            </View>
            <View style={styles.matchupScores}>
                <View style={styles.matchupSide}>
                    <Text style={styles.matchupTeam} numberOfLines={1}>{matchup.myTeamName}</Text>
                    <Text style={[styles.matchupScore, iWinning && styles.winningScore]}>{fmt(matchup.myPoints)}</Text>
                </View>
                <Text style={styles.matchupVs}>vs</Text>
                <View style={[styles.matchupSide, styles.matchupSideRight]}>
                    <Text style={styles.matchupTeam} numberOfLines={1}>{matchup.opponentTeamName}</Text>
                    <Text style={[styles.matchupScore, !iWinning && styles.winningScore]}>{fmt(matchup.opponentPoints)}</Text>
                </View>
            </View>
        </View>
    )
}

// ── No league state ────────────────────────────────────────────

function NoLeagueState() {
    const { push } = useRouter()
    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.noLeague}>
                <Text style={styles.noLeagueTitle}>Welcome to Pancake</Text>
                <Text style={styles.noLeagueSub}>Create a new league or join one with an invite code.</Text>
                <Pressable style={styles.primaryButton} onPress={() => push('/(modals)/create-league')}>
                    <Text style={styles.primaryButtonText}>Create a League</Text>
                </Pressable>
                <Pressable style={styles.secondaryButton} onPress={() => push('/(modals)/join-league')}>
                    <Text style={styles.secondaryButtonText}>Join with Invite Code</Text>
                </Pressable>
            </View>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#fff' },

    switcherRow: { maxHeight: 48, borderBottomWidth: 1, borderBottomColor: '#eee' },
    switcherContent: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8, paddingVertical: 8 },
    switcherChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, borderCurve: 'continuous' as const, backgroundColor: '#f3f3f3' },
    switcherChipActive: { backgroundColor: '#F97316' },
    switcherText: { fontSize: 13, fontWeight: '600', color: '#555' },
    switcherTextActive: { color: '#fff' },

    scrollContent: { paddingBottom: 40 },

    // Score card
    matchupCard: {
        margin: 16,
        backgroundColor: '#fff',
        borderRadius: 16,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: '#eee',
        padding: 20,
        gap: 16,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.06)',
    },
    matchupHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    matchupWeek: { fontSize: 13, fontWeight: '700', color: '#aaa', letterSpacing: 0.5 },
    statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderCurve: 'continuous' as const },
    statusText: { fontSize: 12, fontWeight: '700' },
    matchupScores: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    matchupSide: { flex: 1, gap: 4 },
    matchupSideRight: { alignItems: 'flex-end' },
    matchupTeam: { fontSize: 13, color: '#888', fontWeight: '500' },
    matchupScore: { fontSize: 36, fontWeight: '800', color: '#ccc' },
    winningScore: { color: '#111' },
    matchupVs: { fontSize: 14, color: '#ccc', fontWeight: '600', paddingHorizontal: 4 },

    // Day selector
    daySelectorRow: { borderBottomWidth: 1, borderBottomColor: '#eee' },
    daySelectorContent: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10, gap: 6 },
    dayCell: { width: 40, alignItems: 'center', paddingVertical: 6, borderRadius: 10, borderCurve: 'continuous' as const, gap: 2 },
    dayCellSelected: { backgroundColor: '#F97316' },
    dayCellToday: { backgroundColor: '#FFF7ED' },
    dayCellNoGames: { opacity: 0.4 },
    dayLabel: { fontSize: 11, fontWeight: '700', color: '#888' },
    dayLabelSelected: { color: '#fff' },
    dayLabelFaint: { color: '#ccc' },
    dayNum: { fontSize: 15, fontWeight: '800', color: '#111' },
    dayNumSelected: { color: '#fff' },
    dayNumFaint: { color: '#ccc' },
    gameDot: { width: 5, height: 5, borderRadius: 3, borderCurve: 'continuous' as const, backgroundColor: '#F97316', marginTop: 1 },
    gameDotSelected: { backgroundColor: 'rgba(255,255,255,0.7)' },

    // Lineup header
    lineupHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 4,
        gap: 0,
    },
    lineupTeamName: { flex: 1, fontSize: 12, fontWeight: '700', color: '#aaa', letterSpacing: 0.3 },
    autoSetBtn: {
        height: 28,
        borderRadius: 8,
        borderCurve: 'continuous' as const,
        borderWidth: 1.5,
        borderColor: '#F97316',
        alignItems: 'center',
        justifyContent: 'center',
    },
    autoSetText: { fontSize: 11, fontWeight: '800', color: '#F97316', letterSpacing: 0.5 },

    // Selection hint
    hint: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#FFF7ED',
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: '#FED7AA',
        paddingHorizontal: 16,
        paddingVertical: 9,
        marginTop: 4,
    },
    hintText: { flex: 1, fontSize: 13, color: '#C2410C', fontWeight: '500' },
    hintCancel: { fontSize: 13, fontWeight: '700', color: '#F97316', paddingLeft: 12 },

    // Lineup rows
    lineupContainer: { paddingHorizontal: 16 },
    matchupRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: '#f3f3f3',
        gap: 8,
    },

    rowSideLeft: { flex: 1, alignItems: 'flex-end' },
    rowSideRight: { flex: 1, alignItems: 'flex-start' },

    sideName: { fontSize: 13, fontWeight: '600', color: '#111', flexShrink: 1 },
    noGameName: { color: '#ccc' },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
    sideMeta: { fontSize: 11, color: '#aaa' },

    posTag: { paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4, borderCurve: 'continuous' as const, flexShrink: 0 },
    posTagText: { fontSize: 9, fontWeight: '800' },

    slotChipCenter: {
        width: SLOT_W,
        height: 30,
        borderRadius: 8,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    slotChipSelected: { borderWidth: 1.5, borderColor: '#F97316' },
    slotChipText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
    injuryBadge: { paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4, flexShrink: 0 },
    injuryBadgeText: { fontSize: 9, fontWeight: '800' },

    dividerRow: { paddingTop: 12, paddingBottom: 3 },
    dividerText: { fontSize: 10, fontWeight: '800', color: '#bbb', letterSpacing: 0.8 },

    noLineup: { padding: 32, alignItems: 'center', gap: 12 },
    noLineupText: { fontSize: 14, color: '#aaa', textAlign: 'center' },
    setLineupBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, borderCurve: 'continuous' as const, backgroundColor: '#F97316' },
    setLineupBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

    noMatchup: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8, padding: 32 },
    noMatchupText: { fontSize: 16, fontWeight: '600', color: '#555' },
    noMatchupSub: { fontSize: 13, color: '#aaa', textAlign: 'center' },

    // IR overflow modal
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
    modalSheet: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, gap: 12 },
    modalTitle: { fontSize: 17, fontWeight: '800', color: '#111' },
    modalSub: { fontSize: 13, color: '#888', marginBottom: 4 },
    overflowRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f3f3f3', gap: 8 },
    overflowName: { fontSize: 14, fontWeight: '600', color: '#111' },
    overflowMeta: { fontSize: 12, color: '#888', marginTop: 1 },
    overflowBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
    overflowBtnText: { fontSize: 12, fontWeight: '700' },
    modalCancel: { paddingVertical: 14, alignItems: 'center' },
    modalCancelText: { fontSize: 15, fontWeight: '600', color: '#888' },

    noLeague: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 16 },
    noLeagueTitle: { fontSize: 28, fontWeight: '800', textAlign: 'center' },
    noLeagueSub: { fontSize: 15, color: '#888', textAlign: 'center', marginBottom: 8 },
    primaryButton: { width: '100%', height: 52, backgroundColor: '#F97316', borderRadius: 12, borderCurve: 'continuous' as const, justifyContent: 'center', alignItems: 'center' },
    primaryButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
    secondaryButton: { width: '100%', height: 52, borderWidth: 1.5, borderColor: '#F97316', borderRadius: 12, borderCurve: 'continuous' as const, justifyContent: 'center', alignItems: 'center' },
    secondaryButtonText: { color: '#F97316', fontWeight: '700', fontSize: 16 },
})
