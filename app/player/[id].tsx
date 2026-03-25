import {
    View,
    Text,
    ScrollView,
    StyleSheet,
    ActivityIndicator,
    TouchableOpacity,
    Alert,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, Stack, router } from 'expo-router'
import { useEffect, useState } from 'react'
import { getPlayer, getPlayerSeasonAverages, getPlayerRecentGames } from '@/lib/players'
import { getPlayerRosterStatus, addFreeAgent, dropPlayer, PlayerRosterStatus } from '@/lib/roster'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'

const INJURY_COLORS: Record<string, string> = {
    Questionable: '#F59E0B',
    Doubtful: '#F97316',
    Out: '#EF4444',
    IR: '#7F1D1D',
}

export default function PlayerDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>()
    const { current } = useLeagueContext()
    const { user } = useAuth()
    const [player, setPlayer] = useState<any>(null)
    const [averages, setAverages] = useState<any>(null)
    const [recentGames, setRecentGames] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [rosterStatus, setRosterStatus] = useState<PlayerRosterStatus | null>(null)
    const [actionLoading, setActionLoading] = useState(false)

    async function loadRosterStatus() {
        if (!current || !user) return
        const league = current.leagues as any
        try {
            const status = await getPlayerRosterStatus(id, current.id, league.id)
            setRosterStatus(status)
        } catch (e) {
            console.error(e)
        }
    }

    useEffect(() => {
        async function load() {
            try {
                const [p, avg, games] = await Promise.all([
                    getPlayer(id),
                    getPlayerSeasonAverages(id),
                    getPlayerRecentGames(id),
                ])
                setPlayer(p)
                setAverages(avg)
                setRecentGames(games)
            } catch (e) {
                console.error(e)
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [id])

    useEffect(() => {
        loadRosterStatus()
    }, [id, current, user])

    async function handleAdd() {
        if (!current || !user) return
        const league = current.leagues as any
        setActionLoading(true)
        try {
            await addFreeAgent(current.id, league.id, id)
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

    if (loading) {
        return (
            <SafeAreaView style={styles.container}>
                <ActivityIndicator style={{ flex: 1 }} color="#F97316" />
            </SafeAreaView>
        )
    }

    if (!player) {
        return (
            <SafeAreaView style={styles.container}>
                <Text style={styles.errorText}>Player not found.</Text>
            </SafeAreaView>
        )
    }

    return (
        <>
            <Stack.Screen options={{ title: player.display_name, headerBackTitle: 'Players' }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
                <ScrollView contentContainerStyle={styles.scroll}>
                    {/* Header */}
                    <View style={styles.header}>
                        <View style={styles.headerInfo}>
                            <Text style={styles.name}>{player.display_name}</Text>
                            <Text style={styles.meta}>
                                {[player.nba_team, player.position].filter(Boolean).join(' · ')}
                            </Text>
                            {player.injury_status && (
                                <View
                                    style={[
                                        styles.injuryBadge,
                                        {
                                            backgroundColor:
                                                INJURY_COLORS[player.injury_status] ?? '#888',
                                        },
                                    ]}
                                >
                                    <Text style={styles.injuryText}>{player.injury_status}</Text>
                                </View>
                            )}
                        </View>

                        {/* Roster action button */}
                        {current &&
                            rosterStatus &&
                            (rosterStatus.status === 'free_agent' ? (
                                <TouchableOpacity
                                    style={styles.addButton}
                                    onPress={handleAdd}
                                    disabled={actionLoading}
                                >
                                    {actionLoading ? (
                                        <ActivityIndicator size="small" color="#fff" />
                                    ) : (
                                        <Text style={styles.addButtonText}>+ Add</Text>
                                    )}
                                </TouchableOpacity>
                            ) : rosterStatus.status === 'on_waivers' ? (
                                <TouchableOpacity
                                    style={styles.claimButton}
                                    onPress={() =>
                                        router.push(
                                            `/(modals)/claim-player?playerId=${id}`,
                                        )
                                    }
                                    disabled={actionLoading}
                                >
                                    <Text style={styles.claimButtonText}>Claim</Text>
                                </TouchableOpacity>
                            ) : rosterStatus.status === 'mine' ? (
                                <TouchableOpacity
                                    style={styles.dropButton}
                                    onPress={handleDrop}
                                    disabled={actionLoading}
                                >
                                    {actionLoading ? (
                                        <ActivityIndicator size="small" color="#EF4444" />
                                    ) : (
                                        <Text style={styles.dropButtonText}>Drop</Text>
                                    )}
                                </TouchableOpacity>
                            ) : (
                                <View style={styles.takenBadge}>
                                    <Text style={styles.takenText}>
                                        {rosterStatus.ownerTeamName}
                                    </Text>
                                </View>
                            ))}
                    </View>

                    {/* Season averages */}
                    <View style={styles.section}>
                        <Text style={styles.sectionTitle}>2024–25 Averages</Text>
                        {averages ? (
                            <>
                                <View style={styles.statsGrid}>
                                    {[
                                        { label: 'PTS', value: averages.points },
                                        { label: 'REB', value: averages.rebounds },
                                        { label: 'AST', value: averages.assists },
                                        { label: 'STL', value: averages.steals },
                                        { label: 'BLK', value: averages.blocks },
                                        { label: '3PM', value: averages.threesMade },
                                        { label: 'TO', value: averages.turnovers },
                                        { label: 'MIN', value: averages.minutes },
                                    ].map(({ label, value }) => (
                                        <View key={label} style={styles.statCell}>
                                            <Text style={styles.statValue}>{value.toFixed(1)}</Text>
                                            <Text style={styles.statLabel}>{label}</Text>
                                        </View>
                                    ))}
                                </View>
                                <Text style={styles.gamesNote}>{averages.games} games played</Text>
                            </>
                        ) : (
                            <Text style={styles.noData}>No stats available yet.</Text>
                        )}
                    </View>

                    {/* Recent game log */}
                    <View style={styles.section}>
                        <Text style={styles.sectionTitle}>Recent Games</Text>
                        {recentGames.length === 0 ? (
                            <Text style={styles.noData}>No recent games.</Text>
                        ) : (
                            <>
                                {/* Table header */}
                                <View style={[styles.gameRow, styles.gameRowHeader]}>
                                    <Text
                                        style={[
                                            styles.gameCell,
                                            styles.gameCellDate,
                                            styles.colHeader,
                                        ]}
                                    >
                                        DATE
                                    </Text>
                                    <Text style={[styles.gameCell, styles.colHeader]}>PTS</Text>
                                    <Text style={[styles.gameCell, styles.colHeader]}>REB</Text>
                                    <Text style={[styles.gameCell, styles.colHeader]}>AST</Text>
                                    <Text style={[styles.gameCell, styles.colHeader]}>STL</Text>
                                    <Text style={[styles.gameCell, styles.colHeader]}>BLK</Text>
                                    <Text style={[styles.gameCell, styles.colHeader]}>MIN</Text>
                                </View>
                                {recentGames.map((g, i) => {
                                    const game = g.nba_games as any
                                    const date = game?.game_date
                                        ? new Date(game.game_date).toLocaleDateString('en-US', {
                                              month: 'short',
                                              day: 'numeric',
                                          })
                                        : '—'
                                    return (
                                        <View
                                            key={i}
                                            style={[
                                                styles.gameRow,
                                                i % 2 === 1 && styles.gameRowAlt,
                                            ]}
                                        >
                                            <Text style={[styles.gameCell, styles.gameCellDate]}>
                                                {date}
                                            </Text>
                                            <Text style={styles.gameCell}>
                                                {g.did_not_play ? 'DNP' : (g.points ?? '—')}
                                            </Text>
                                            <Text style={styles.gameCell}>
                                                {g.did_not_play ? '' : (g.rebounds ?? '—')}
                                            </Text>
                                            <Text style={styles.gameCell}>
                                                {g.did_not_play ? '' : (g.assists ?? '—')}
                                            </Text>
                                            <Text style={styles.gameCell}>
                                                {g.did_not_play ? '' : (g.steals ?? '—')}
                                            </Text>
                                            <Text style={styles.gameCell}>
                                                {g.did_not_play ? '' : (g.blocks ?? '—')}
                                            </Text>
                                            <Text style={styles.gameCell}>
                                                {g.did_not_play
                                                    ? ''
                                                    : Number(g.minutes_played ?? 0).toFixed(0)}
                                            </Text>
                                        </View>
                                    )
                                })}
                            </>
                        )}
                    </View>
                </ScrollView>
            </SafeAreaView>
        </>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#fff' },
    scroll: { padding: 20, gap: 24 },

    header: { flexDirection: 'row', alignItems: 'flex-start', gap: 16 },
    headerInfo: { flex: 1 },
    name: { fontSize: 24, fontWeight: '800' },
    meta: { fontSize: 15, color: '#888', marginTop: 4 },
    injuryBadge: {
        marginTop: 8,
        alignSelf: 'flex-start',
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
    },
    injuryText: { color: '#fff', fontSize: 12, fontWeight: '700' },

    section: { gap: 12 },
    sectionTitle: { fontSize: 17, fontWeight: '700', color: '#111' },
    noData: { color: '#aaa', fontSize: 14 },
    gamesNote: { fontSize: 12, color: '#aaa' },

    statsGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 1,
        backgroundColor: '#eee',
        borderRadius: 12,
        overflow: 'hidden',
    },
    statCell: {
        flex: 1,
        minWidth: '22%',
        backgroundColor: '#fff',
        alignItems: 'center',
        paddingVertical: 12,
        gap: 4,
    },
    statValue: { fontSize: 20, fontWeight: '700' },
    statLabel: { fontSize: 11, color: '#888', fontWeight: '600' },

    gameRow: { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 4 },
    gameRowHeader: { borderBottomWidth: 1, borderBottomColor: '#eee' },
    gameRowAlt: { backgroundColor: '#fafafa' },
    gameCell: { flex: 1, textAlign: 'center', fontSize: 14, color: '#333' },
    gameCellDate: { flex: 1.5, textAlign: 'left', color: '#666' },
    colHeader: { fontSize: 11, fontWeight: '700', color: '#aaa' },

    errorText: { textAlign: 'center', marginTop: 40, color: '#888' },

    addButton: {
        backgroundColor: '#F97316',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 10,
        minWidth: 72,
        alignItems: 'center',
        alignSelf: 'flex-start',
    },
    addButtonText: { color: '#fff', fontWeight: '700', fontSize: 14 },

    dropButton: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 10,
        borderWidth: 1.5,
        borderColor: '#EF4444',
        minWidth: 72,
        alignItems: 'center',
        alignSelf: 'flex-start',
    },
    dropButtonText: { color: '#EF4444', fontWeight: '700', fontSize: 14 },

    takenBadge: {
        backgroundColor: '#f3f3f3',
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 8,
        alignSelf: 'flex-start',
    },
    takenText: { color: '#888', fontSize: 12, fontWeight: '600' },

    claimButton: {
        backgroundColor: '#8B5CF6',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 10,
        minWidth: 72,
        alignItems: 'center',
        alignSelf: 'flex-start',
    },
    claimButtonText: { color: '#fff', fontWeight: '700', fontSize: 14 },
})
