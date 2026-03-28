import {
    View,
    Text,
    ScrollView,
    StyleSheet,
    ActivityIndicator,
    Alert,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, Stack, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import {
    getPlayer,
    getAvailableSeasons,
    getPlayerSeasonAveragesFromView,
    getPlayerGameLog,
    getPlayerFantasyPoints,
    getPlayerTransactionHistory,
    type PlayerSeasonAverages,
    type GameLogEntry,
    type TransactionHistoryEntry,
} from '@/lib/players'
import { currentSeasonYear } from '@/lib/shared/season'
import { getPlayerRosterStatus, addFreeAgent, dropPlayer, type PlayerRosterStatus } from '@/lib/roster'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { SeasonSelector } from '@/components/player/SeasonSelector'
import { StatsOverview } from '@/components/player/StatsOverview'
import { FantasyCard } from '@/components/player/FantasyCard'
import { GameLogTable } from '@/components/player/GameLogTable'
import { TransactionHistory } from '@/components/player/TransactionHistory'
import { LoadingScreen } from '@/components/LoadingScreen'
import { colors, fontSize, fontWeight, spacing } from '@/constants/tokens'

const GAME_LOG_PAGE = 15

export default function PlayerDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>()
    const { current } = useLeagueContext()
    const { user } = useAuth()
    const { push } = useRouter()

    // Player core data
    const [player, setPlayer] = useState<any>(null)
    const [loading, setLoading] = useState(true)

    // Roster status
    const [rosterStatus, setRosterStatus] = useState<PlayerRosterStatus | null>(null)
    const [actionLoading, setActionLoading] = useState(false)

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

    const league = current?.leagues as any
    const leagueId: string | null = league?.id ?? null

    // ── Load player core + available seasons ────────────────────────────────
    useEffect(() => {
        async function load() {
            try {
                const [p, seasons] = await Promise.all([
                    getPlayer(id),
                    getAvailableSeasons(id),
                ])
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
            await addFreeAgent(current.id, leagueId!, id)
            await loadRosterStatus()
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setActionLoading(false)
        }
    }

    async function handleDrop() {
        if (rosterStatus?.status !== 'mine') return
        Alert.alert(
            'Drop Player',
            `Drop ${player?.display_name ?? 'this player'}? They will become a free agent.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Drop',
                    style: 'destructive',
                    onPress: async () => {
                        setActionLoading(true)
                        try {
                            await dropPlayer(rosterStatus.rosterPlayerId)
                            await loadRosterStatus()
                        } catch (e: any) {
                            Alert.alert('Error', e.message)
                        } finally {
                            setActionLoading(false)
                        }
                    },
                },
            ],
        )
    }

    function handleClaim() {
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
})
