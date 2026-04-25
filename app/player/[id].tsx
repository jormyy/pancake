import { IRResolutionModal } from '@/components/IRResolutionModal'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { LoadingScreen } from '@/components/LoadingScreen'
import { FantasyCard } from '@/components/player/FantasyCard'
import { GameLogTable } from '@/components/player/GameLogTable'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { SeasonSelector } from '@/components/player/SeasonSelector'
import { StatsOverview } from '@/components/player/StatsOverview'
import { TransactionHistory } from '@/components/player/TransactionHistory'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import {
    getAvailableSeasons,
    getPlayer,
    getPlayerFantasyPoints,
    getPlayerGameLog,
    getPlayerSeasonAveragesFromView,
    getPlayerTransactionHistory,
    type GameLogEntry,
    type PlayerSeasonAverages,
    type TransactionHistoryEntry,
} from '@/lib/players'
import { addFreeAgent, dropPlayer, getPlayerRosterStatus, getRoster, isIREligible, toggleIR, type PlayerRosterStatus, type RosterPlayer } from '@/lib/roster'
import { isIneligibleIR } from '@/lib/format'
import { todayDateString } from '@/lib/shared/dates'
import { currentSeasonYear } from '@/lib/shared/season'
import { supabase } from '@/lib/supabase'
import { showAlert, confirmAction } from '@/lib/alert'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import {
    ActivityIndicator,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

const GAME_LOG_PAGE = 15

export default function PlayerDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>()
    const { current, currentLeague } = useLeagueContext()
    const { user } = useAuth()
    const { push } = useRouter()

    // Player core data
    const [player, setPlayer] = useState<any>(null)
    const [loading, setLoading] = useState(true)

    // Roster status
    const [rosterStatus, setRosterStatus] = useState<PlayerRosterStatus | null>(null)
    const [actionLoading, setActionLoading] = useState(false)
    const [playedToday, setPlayedToday] = useState(false)

    // Drop picker + IR resolution state
    const [dropPickerVisible, setDropPickerVisible] = useState(false)
    const [myRoster, setMyRoster] = useState<RosterPlayer[]>([])
    const [dropping, setDropping] = useState<string | null>(null)
    const [irModal, setIrModal] = useState<{
        ineligible: RosterPlayer[]
        roster: RosterPlayer[]
    } | null>(null)

    // Season navigation
    const [availableSeasons, setAvailableSeasons] = useState<number[]>([])
    const [selectedSeason, setSelectedSeason] = useState<number>(currentSeasonYear())

    // Season-dependent data
    const [seasonAverages, setSeasonAverages] = useState<PlayerSeasonAverages | null>(null)
    const [seasonLoading, setSeasonLoading] = useState(false)

    // Game log
    const [gameLog, setGameLog] = useState<GameLogEntry[]>([])
    const [gameLogOffset, setGameLogOffset] = useState(0)
    const [hasMoreGames, setHasMoreGames] = useState(false)
    const [gameLogLoading, setGameLogLoading] = useState(false)

    // Fantasy points (league-aware)
    const [fantasyPointsMap, setFantasyPointsMap] = useState<Map<string, number> | null>(null)
    const [avgFantasyPoints, setAvgFantasyPoints] = useState(0)

    // Transaction history (league-aware, once per player/league)
    const [transactions, setTransactions] = useState<TransactionHistoryEntry[]>([])

    const leagueId = currentLeague?.id ?? null

    // ── Load player core + available seasons ────────────────────────────────
    useEffect(() => {
        async function load() {
            try {
                const [p, seasons, todayStats] = await Promise.all([
                    getPlayer(id),
                    getAvailableSeasons(id),
                    supabase
                        .from('player_game_stats')
                        .select('did_not_play')
                        .eq('player_id', id)
                        .eq('game_date', todayDateString())
                        .maybeSingle(),
                ])
                setPlayedToday(todayStats.data != null && todayStats.data.did_not_play === false)
                setPlayer(p)
                setAvailableSeasons(seasons)
                if (seasons.length > 0 && !seasons.includes(selectedSeason)) {
                    setSelectedSeason(seasons[0])
                }
            } catch (e) {
                console.error(e)
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [id])

    // ── Load roster status ───────────────────────────────────────────────────
    async function loadRosterStatus() {
        if (!current || !user) return
        try {
            const status = await getPlayerRosterStatus(id, current.id, leagueId!)
            setRosterStatus(status)
        } catch (e) {
            console.error(e)
        }
    }

    useEffect(() => {
        loadRosterStatus()
    }, [id, current, user])

    // ── Load season-dependent data ───────────────────────────────────────────
    useEffect(() => {
        if (!player) return
        async function loadSeasonData() {
            setSeasonLoading(true)
            setGameLog([])
            setGameLogOffset(0)
            setHasMoreGames(false)
            setFantasyPointsMap(null)
            setAvgFantasyPoints(0)

            try {
                const [avgs, gameLogResult] = await Promise.all([
                    getPlayerSeasonAveragesFromView(id, selectedSeason),
                    getPlayerGameLog(id, player.nba_team, selectedSeason, GAME_LOG_PAGE, 0),
                ])
                setSeasonAverages(avgs)
                setGameLog(gameLogResult.games)
                setGameLogOffset(gameLogResult.games.length)
                setHasMoreGames(gameLogResult.hasMore)
            } catch (e) {
                console.error(e)
            } finally {
                setSeasonLoading(false)
            }
        }
        loadSeasonData()
    }, [id, selectedSeason, player])

    // ── Load fantasy points when league changes ──────────────────────────────
    useEffect(() => {
        if (!leagueId || !player) return
        async function loadFantasy() {
            try {
                const pts = await getPlayerFantasyPoints(id, leagueId!, selectedSeason)
                const map = new Map(pts.map((p) => [p.gameId, p.fantasyPoints]))
                setFantasyPointsMap(map)
                if (pts.length > 0) {
                    const avg = pts.reduce((sum, p) => sum + p.fantasyPoints, 0) / pts.length
                    setAvgFantasyPoints(avg)
                }
            } catch (e) {
                console.error(e)
            }
        }
        loadFantasy()
    }, [id, leagueId, selectedSeason, player])

    // ── Load transaction history once per player/league ─────────────────────
    useEffect(() => {
        if (!leagueId) return
        async function loadTransactions() {
            try {
                const tx = await getPlayerTransactionHistory(id, leagueId!)
                setTransactions(tx)
            } catch (e) {
                console.error(e)
            }
        }
        loadTransactions()
    }, [id, leagueId])

    // ── Load more games ──────────────────────────────────────────────────────
    async function loadMoreGames() {
        if (gameLogLoading || !hasMoreGames || !player) return
        setGameLogLoading(true)
        try {
            const result = await getPlayerGameLog(
                id,
                player.nba_team,
                selectedSeason,
                GAME_LOG_PAGE,
                gameLogOffset,
            )
            setGameLog((prev) => [...prev, ...result.games])
            setGameLogOffset((prev) => prev + result.games.length)
            setHasMoreGames(result.hasMore)
        } catch (e) {
            console.error(e)
        } finally {
            setGameLogLoading(false)
        }
    }

    // ── Season selector handler ──────────────────────────────────────────────
    function handleSeasonSelect(year: number) {
        if (year === selectedSeason) return
        setSelectedSeason(year)
    }

    // ── Roster actions ───────────────────────────────────────────────────────
    async function handleAdd() {
        if (!current || !user) return
        setActionLoading(true)
        try {
            // Check for ineligible IR players before adding
            const roster = await getRoster(current.id, leagueId!)
            const ineligible = roster.filter((r) => isIneligibleIR(r))

            if (ineligible.length > 0) {
                setActionLoading(false)
                setIrModal({ ineligible, roster })
                return
            }

            await tryAddFreeAgent()
        } catch (e: any) {
            showAlert('Error', e.message)
        } finally {
            setActionLoading(false)
        }
    }

    async function tryAddFreeAgent() {
        if (!current || !leagueId) return
        setActionLoading(true)
        try {
            await addFreeAgent(current.id, leagueId, id)
            await loadRosterStatus()
        } catch (e: any) {
            if (e.message?.includes('full')) {
                const roster = await getRoster(current.id, leagueId)
                setMyRoster(roster.filter((r) => !r.is_on_ir))
                setDropPickerVisible(true)
            } else {
                showAlert('Error', e.message)
            }
        } finally {
            setActionLoading(false)
        }
    }

    async function handleDropAndAdd(rosterPlayer: RosterPlayer) {
        if (!current || !leagueId) return
        setDropping(rosterPlayer.id)
        try {
            await dropPlayer(rosterPlayer.id)
            await addFreeAgent(current.id, leagueId, id)
            setDropPickerVisible(false)
            await loadRosterStatus()
        } catch (e: any) {
            showAlert('Error', e.message)
        } finally {
            setDropping(null)
        }
    }

    async function handleIRActivate(rp: RosterPlayer) {
        if (!current || !leagueId) return
        await toggleIR(rp.id, false)
        const roster = await getRoster(current.id, leagueId)
        const remaining = roster.filter((r) => isIneligibleIR(r))
        if (remaining.length > 0) {
            setIrModal((prev) => prev ? { ...prev, ineligible: remaining, roster } : null)
        } else {
            setIrModal(null)
            await tryAddFreeAgent()
        }
    }

    async function handleDropAndIRActivate(toDrop: RosterPlayer, activatePlayer: RosterPlayer) {
        if (!current || !leagueId) return
        await dropPlayer(toDrop.id)
        await toggleIR(activatePlayer.id, false)
        const roster = await getRoster(current.id, leagueId)
        const remaining = roster.filter((r) => isIneligibleIR(r))
        if (remaining.length > 0) {
            setIrModal((prev) => prev ? { ...prev, ineligible: remaining, roster } : null)
        } else {
            setIrModal(null)
            await tryAddFreeAgent()
        }
    }

    function handleDrop() {
        if (rosterStatus?.status !== 'mine') return
        const rosterPlayerId = rosterStatus.rosterPlayerId
        confirmAction(
            `Drop ${player?.display_name ?? 'this player'}?`,
            'They will be placed on waivers for 48 hours.',
            async () => {
                setActionLoading(true)
                try {
                    await dropPlayer(rosterPlayerId)
                    push('/(tabs)/roster')
                } catch (e: any) {
                    showAlert('Error', e.message)
                    setActionLoading(false)
                }
            },
            'Drop',
        )
    }

    async function handleClaim() {
        if (!current || !leagueId) return
        // Check for ineligible IR players before allowing waiver claim
        const roster = await getRoster(current.id, leagueId)
        const ineligible = roster.filter((r) => isIneligibleIR(r))

        if (ineligible.length > 0) {
            setIrModal({ ineligible, roster })
            return
        }

        push(`/(modals)/claim-player?playerId=${id}`)
    }

    // ── Render ───────────────────────────────────────────────────────────────
    if (loading) {
        return <LoadingScreen />
    }

    if (!player) {
        return (
            <SafeAreaView style={styles.container}>
                <Text style={styles.errorText}>Player not found.</Text>
            </SafeAreaView>
        )
    }

    const showFantasy = leagueId != null && fantasyPointsMap !== null && fantasyPointsMap.size > 0
    const showTransactions = leagueId != null && transactions.length > 0

    return (
        <>
            <Stack.Screen options={{ title: player.display_name, headerBackTitle: 'Back' }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
                <ScrollView contentContainerStyle={styles.scroll}>

                    {/* Header */}
                    <PlayerHeader
                        player={player}
                        rosterStatus={rosterStatus}
                        leagueActive={!!current}
                        actionLoading={actionLoading}
                        playedToday={playedToday}
                        onAdd={handleAdd}
                        onDrop={handleDrop}
                        onClaim={handleClaim}
                    />

                    {/* Season selector */}
                    <SeasonSelector
                        seasons={availableSeasons}
                        selectedSeason={selectedSeason}
                        onSelect={handleSeasonSelect}
                    />

                    {seasonLoading ? (
                        <ActivityIndicator color={colors.primary} style={styles.seasonLoader} />
                    ) : (
                        <>
                            {/* Season averages */}
                            {seasonAverages ? (
                                <StatsOverview
                                    averages={seasonAverages}
                                    seasonYear={selectedSeason}
                                />
                            ) : (
                                <View style={styles.section}>
                                    <Text style={styles.sectionTitle}>
                                        {selectedSeason - 1}–{String(selectedSeason).slice(2)} Averages
                                    </Text>
                                    <Text style={styles.noData}>No stats available.</Text>
                                </View>
                            )}

                            {/* Fantasy context */}
                            {showFantasy && (
                                <FantasyCard
                                    avgFantasyPoints={avgFantasyPoints}
                                    gamesCount={fantasyPointsMap!.size}
                                />
                            )}

                            {/* Game log */}
                            <GameLogTable
                                games={gameLog}
                                fantasyPointsMap={showFantasy ? fantasyPointsMap : null}
                                hasMore={hasMoreGames}
                                loadingMore={gameLogLoading}
                                onLoadMore={loadMoreGames}
                            />
                        </>
                    )}

                    {/* Transaction history — always shown regardless of season */}
                    {showTransactions && (
                        <TransactionHistory transactions={transactions} />
                    )}

                </ScrollView>
            </SafeAreaView>

            <DropPlayerPickerModal
                visible={dropPickerVisible}
                title={`Drop a player to add\n${player?.display_name ?? ''}`}
                subtitle="Your roster is full. Pick someone to release."
                roster={myRoster}
                dropping={dropping}
                onDrop={handleDropAndAdd}
                onCancel={() => setDropPickerVisible(false)}
            />

            {/* IR resolution modal */}
            <IRResolutionModal
                visible={irModal !== null}
                ineligibleIR={irModal?.ineligible ?? []}
                activeRoster={(irModal?.roster ?? []).filter((r) => !r.is_on_ir)}
                rosterSize={currentLeague?.roster_size ?? 20}
                pendingPlayerName={player?.display_name ?? ''}
                onActivate={handleIRActivate}
                onDropAndActivate={handleDropAndIRActivate}
                onCancel={() => setIrModal(null)}
            />
        </>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    scroll: { padding: spacing['2xl'], gap: spacing['3xl'] },
    seasonLoader: { marginVertical: spacing['4xl'] },
    section: { gap: spacing.lg },
    sectionTitle: { fontSize: 17, fontWeight: fontWeight.bold, color: colors.textPrimary },
    noData: { color: colors.textPlaceholder, fontSize: fontSize.md },
    errorText: { textAlign: 'center', marginTop: spacing['5xl'], color: colors.textMuted },

    // Drop picker modal
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'flex-end',
    },
    modalCard: {
        backgroundColor: colors.bgScreen,
        borderTopLeftRadius: radii['3xl'],
        borderTopRightRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        paddingTop: spacing['3xl'],
        paddingHorizontal: spacing['2xl'],
        paddingBottom: 36,
        maxHeight: '80%',
    },
    modalTitle: {
        fontSize: 17,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
        textAlign: 'center',
        marginBottom: spacing.xs,
    },
    modalPlayerName: { color: colors.primary },
    modalSub: { fontSize: fontSize.sm, color: colors.textPlaceholder, textAlign: 'center', marginBottom: spacing.xl },
    dropList: { maxHeight: 360 },
    dropRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        gap: spacing.lg,
    },
    dropInfo: { flex: 1 },
    dropName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    dropMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
    dropMeta: { fontSize: 12, color: colors.textMuted },
    dropBtn: {
        backgroundColor: colors.danger,
        paddingHorizontal: spacing.lg + spacing.xxs,
        paddingVertical: 7,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        minWidth: 60,
        alignItems: 'center',
    },
    dropBtnText: { color: colors.textWhite, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
    modalCancel: {
        marginTop: spacing.xl,
        paddingVertical: spacing.lg + spacing.xxs,
        alignItems: 'center',
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgSubtle,
    },
    modalCancelText: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.textSecondary },
})
