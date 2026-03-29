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
import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { getMyMatchup, Matchup, computeLiveFantasyPoints } from '@/lib/scoring'
import { getTodaysGames, getLivePlayerStats, NBAGameRow, LiveStatLine } from '@/lib/games'
import { todayDateString } from '@/lib/shared/dates'
import { supabase } from '@/lib/supabase'
import { Scoreboard } from '@/components/Scoreboard'
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
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { LoadingScreen } from '@/components/LoadingScreen'
import { EmptyState } from '@/components/EmptyState'

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
        () => todayDateString(),
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

    const [todaysGames, setTodaysGames] = useState<NBAGameRow[]>([])
    const [liveStats, setLiveStats] = useState<Map<string, LiveStatLine>>(new Map())

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
                const today = todayDateString()
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

    // ── Scoreboard: load today's games on mount ───────────────────────────
    useEffect(() => {
        getTodaysGames().then(setTodaysGames).catch(() => {})
    }, [])

    // ── Realtime matchup score updates ────────────────────────────────────
    useEffect(() => {
        if (!matchup?.id) return
        const channel = supabase
            .channel(`matchup_${matchup.id}`)
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'matchups',
                filter: `id=eq.${matchup.id}`,
            }, (payload) => {
                const { home_points, away_points, is_finalized, winner_member_id } = payload.new
                setMatchup((prev) => {
                    if (!prev) return prev
                    const isHome = prev.myMemberId === payload.new.home_member_id
                    return {
                        ...prev,
                        myPoints: isHome ? home_points : away_points,
                        opponentPoints: isHome ? away_points : home_points,
                        isFinalized: is_finalized,
                        iWon: winner_member_id ? winner_member_id === prev.myMemberId : null,
                    }
                })
            })
            .subscribe()

        return () => { supabase.removeChannel(channel) }
    }, [matchup?.id])

    // ── Live player stats + scoreboard: poll every 15s when games are active ─
    useEffect(() => {
        getLivePlayerStats(selectedDate).then(setLiveStats).catch(() => {})

        const today = todayDateString()
        const isToday = selectedDate === today

        if (!isToday) return

        const interval = setInterval(() => {
            getTodaysGames().then(setTodaysGames).catch(() => {})
            getLivePlayerStats(selectedDate).then(setLiveStats).catch(() => {})
        }, 15_000)

        return () => clearInterval(interval)
    }, [selectedDate])

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

    // Teams whose game is currently InProgress — used for live stat styling
    const liveTeams = new Set<string>(
        todaysGames
            .filter((g) => g.status === 'InProgress')
            .flatMap((g) => [g.home_team, g.away_team]),
    )

    // Teams on my roster — used to highlight those teams in the scoreboard
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

    if (loading) {
        return <LoadingScreen />
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

            <Scoreboard games={todaysGames} myTeamSet={myTeamSet} />

            {matchupLoading ? (
                <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
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
                                ? <ActivityIndicator size="small" color={colors.primary} />
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
    liveStats,
    liveTeams,
    scoringSettings,
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
    liveStats: Map<string, LiveStatLine>
    liveTeams: Set<string>
    scoringSettings: Record<string, number>
}) {
    const { push } = useRouter()
    const isSel = selected?.kind === selKind && selected.index === selIndex
    const slotColor = slotType === 'IR' ? colors.danger : (POSITION_COLORS[slotType] ?? colors.textPlaceholder)
    const myHasGame = myPlayer?.nbaTeam ? playingTeams.has(myPlayer.nbaTeam) : false
    const oppHasGame = oppPlayer?.nbaTeam ? playingTeams.has(oppPlayer.nbaTeam) : false
    const myStats = myPlayer ? liveStats.get(myPlayer.playerId) : undefined
    const oppStats = oppPlayer ? liveStats.get(oppPlayer.playerId) : undefined
    const myIsLive = myPlayer?.nbaTeam ? liveTeams.has(myPlayer.nbaTeam) : false
    const oppIsLive = oppPlayer?.nbaTeam ? liveTeams.has(oppPlayer.nbaTeam) : false
    const myFpts = myStats && !myStats.didNotPlay ? computeLiveFantasyPoints(myStats, scoringSettings) : null
    const oppFpts = oppStats && !oppStats.didNotPlay ? computeLiveFantasyPoints(oppStats, scoringSettings) : null
    // Hide injury badge while the game is live — player is clearly active
    const myShowInjury = myPlayer?.injuryStatus && !myIsLive
    const oppShowInjury = oppPlayer?.injuryStatus && !oppIsLive

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
                            {myShowInjury && <InjuryBadge status={myPlayer.injuryStatus} />}
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
                        {myIsLive && !myStats ? (
                            <Text style={[styles.statLine, styles.statLineLive]} numberOfLines={1}>In game</Text>
                        ) : myStats ? (
                            <StatLines stats={myStats} isLive={myIsLive} fpts={myFpts} align="right" />
                        ) : null}
                    </>
                ) : (
                    <Text style={[styles.sideName, { color: colors.border, textAlign: 'right' }]}>—</Text>
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
                <Text style={[styles.slotChipText, { color: isSel ? colors.primary : slotColor }]}>
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
                            {oppShowInjury && <InjuryBadge status={oppPlayer.injuryStatus} />}
                        </View>
                        <View style={styles.metaRow}>
                            {oppPlayer.position && <PosTag position={oppPlayer.position} />}
                            <Text style={styles.sideMeta} numberOfLines={1}>
                                {oppPlayer.nbaTeam ?? 'FA'}{!oppHasGame ? ' · No game' : ''}
                            </Text>
                        </View>
                        {oppIsLive && !oppStats ? (
                            <Text style={[styles.statLine, { textAlign: 'left' }, styles.statLineLive]} numberOfLines={1}>In game</Text>
                        ) : oppStats ? (
                            <StatLines stats={oppStats} isLive={oppIsLive} fpts={oppFpts} align="left" />
                        ) : null}
                    </>
                ) : (
                    <Text style={[styles.sideName, { color: colors.border }]}>—</Text>
                )}
            </Pressable>
        </View>
    )
}

function StatLines({ stats, isLive, fpts, align }: {
    stats: LiveStatLine
    isLive: boolean
    fpts: number | null
    align: 'left' | 'right'
}) {
    const base = [styles.statLine, isLive ? styles.statLineLive : null, { textAlign: align }]
    if (stats.didNotPlay) return <Text style={base}>DNP</Text>
    const line1 = `${stats.points}p ${stats.rebounds}r ${stats.assists}a ${stats.steals}s ${stats.blocks}b ${stats.turnovers ?? 0}to`
    const fg = `${stats.fgMade}/${stats.fgAttempted}`
    const ft = `${stats.ftMade}/${stats.ftAttempted}`
    const line2 = `${fg} ${ft} ${stats.threeMade}x3 ${stats.fouls}f${fpts != null ? ` · ${fpts}` : ''}`
    return (
        <>
            <Text style={base} numberOfLines={1}>{line1}</Text>
            <Text style={base} numberOfLines={1}>{line2}</Text>
        </>
    )
}

function PosTag({ position }: { position: string }) {
    const color = POSITION_COLORS[position] ?? palette.gray500
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
    let color: string = colors.textPlaceholder
    if (s === 'out') { color = colors.danger; label = 'OUT' }
    else if (s.startsWith('ir')) { color = palette.red900; label = 'IR' }
    else if (s === 'gtd' || s === 'game time decision') { color = palette.amber600; label = 'GTD' }
    else if (s === 'd-td' || s === 'day-to-day') { color = colors.primary; label = 'D-TD' }
    else return null

    return (
        <View style={[styles.injuryBadge, { backgroundColor: color + '22' }]}>
            <Text style={[styles.injuryBadgeText, { color }]}>{label}</Text>
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
    let statusColor: string = colors.primary
    if (matchup.isFinalized) {
        statusLabel = matchup.iWon ? 'Win' : 'Loss'
        statusColor = matchup.iWon ? colors.success : colors.danger
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
    container: { flex: 1, backgroundColor: colors.bgScreen },

    switcherRow: { maxHeight: 48, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
    switcherContent: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8, paddingVertical: 8 },
    switcherChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, borderCurve: 'continuous' as const, backgroundColor: colors.bgMuted },
    switcherChipActive: { backgroundColor: colors.primary },
    switcherText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
    switcherTextActive: { color: colors.textWhite },

    scrollContent: { paddingTop: 28, paddingBottom: 40 },

    // Score card
    matchupCard: {
        margin: 16,
        backgroundColor: colors.bgCard,
        borderRadius: 16,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        padding: 20,
        gap: 16,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.06)',
    },
    matchupHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    matchupWeek: { fontSize: 13, fontWeight: '700', color: colors.textPlaceholder, letterSpacing: 0.5 },
    statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderCurve: 'continuous' as const },
    statusText: { fontSize: 12, fontWeight: '700' },
    matchupScores: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    matchupSide: { flex: 1, gap: 4 },
    matchupSideRight: { alignItems: 'flex-end' },
    matchupTeam: { fontSize: 13, color: colors.textMuted, fontWeight: '500' },
    matchupScore: { fontSize: 36, fontWeight: '800', color: palette.gray500 },
    winningScore: { color: colors.textPrimary },
    matchupVs: { fontSize: 14, color: palette.gray500, fontWeight: '600', paddingHorizontal: 4 },

    // Day selector
    daySelectorRow: { borderBottomWidth: 1, borderBottomColor: colors.borderLight },
    daySelectorContent: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10, gap: 6 },
    dayCell: { width: 40, alignItems: 'center', paddingVertical: 6, borderRadius: 10, borderCurve: 'continuous' as const, gap: 2 },
    dayCellSelected: { backgroundColor: colors.primary },
    dayCellToday: { backgroundColor: colors.primaryLight },
    dayCellNoGames: { opacity: 0.4 },
    dayLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted },
    dayLabelSelected: { color: colors.textWhite },
    dayLabelFaint: { color: palette.gray500 },
    dayNum: { fontSize: 15, fontWeight: '800', color: colors.textPrimary },
    dayNumSelected: { color: colors.textWhite },
    dayNumFaint: { color: palette.gray500 },
    gameDot: { width: 5, height: 5, borderRadius: 3, borderCurve: 'continuous' as const, backgroundColor: colors.primary, marginTop: 1 },
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
    lineupTeamName: { flex: 1, fontSize: 12, fontWeight: '700', color: colors.textPlaceholder, letterSpacing: 0.3 },
    autoSetBtn: {
        height: 28,
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

    // Lineup rows
    lineupContainer: { paddingHorizontal: 16 },
    matchupRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        gap: 8,
    },

    rowSideLeft: { flex: 1, alignItems: 'flex-end' },
    rowSideRight: { flex: 1, alignItems: 'flex-start' },

    sideName: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },
    noGameName: { color: palette.gray500 },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
    sideMeta: { fontSize: 11, color: colors.textPlaceholder },
    statLine: { fontSize: 11, color: colors.textMuted, textAlign: 'right', marginTop: 1 },
    statLineLive: { color: colors.primary, fontWeight: fontWeight.semibold },

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
    slotChipSelected: { borderWidth: 1.5, borderColor: colors.primary },
    slotChipText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
    injuryBadge: { paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4, flexShrink: 0 },
    injuryBadgeText: { fontSize: 9, fontWeight: '800' },

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

    noLeague: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 16 },
    noLeagueTitle: { fontSize: 28, fontWeight: '800', textAlign: 'center' },
    noLeagueSub: { fontSize: 15, color: colors.textMuted, textAlign: 'center', marginBottom: 8 },
    primaryButton: { width: '100%', height: 52, backgroundColor: colors.primary, borderRadius: 12, borderCurve: 'continuous' as const, justifyContent: 'center', alignItems: 'center' },
    primaryButtonText: { color: colors.textWhite, fontWeight: '700', fontSize: 16 },
    secondaryButton: { width: '100%', height: 52, borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12, borderCurve: 'continuous' as const, justifyContent: 'center', alignItems: 'center' },
    secondaryButtonText: { color: colors.primary, fontWeight: '700', fontSize: 16 },
})
