import {
    View,
    Text,
    ScrollView,
    StyleSheet,
    ActivityIndicator,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack } from 'expo-router'
import { useEffect, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { getPlayoffBracket, PlayoffBracket, BracketMatchup } from '@/lib/bracket'

export default function BracketScreen() {
    const { current } = useLeagueContext()
    const { user } = useAuth()
    const [bracket, setBracket] = useState<PlayoffBracket | null>(null)
    const [loading, setLoading] = useState(true)

    const league = current?.leagues as any
    const myMemberId = current?.id

    useEffect(() => {
        async function load() {
            if (!current) return
            try {
                const data = await getPlayoffBracket(league.id)
                setBracket(data)
            } catch (e) {
                console.error(e)
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [current])

    return (
        <>
            <Stack.Screen options={{ title: 'Playoff Bracket', presentation: 'modal' }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
                {loading ? (
                    <ActivityIndicator style={{ flex: 1 }} color="#F97316" />
                ) : !bracket || (bracket.semifinals.length === 0 && !bracket.final) ? (
                    <View style={styles.empty}>
                        <Text style={styles.emptyTitle}>No Bracket Yet</Text>
                        <Text style={styles.emptyText}>
                            The commissioner generates the playoff bracket at the end of the regular
                            season.
                        </Text>
                    </View>
                ) : (
                    <ScrollView contentContainerStyle={styles.scroll}>
                        {bracket.champion && (
                            <View style={styles.championBanner}>
                                <Text style={styles.championLabel}>🏆 CHAMPION</Text>
                                <Text style={styles.championName}>{bracket.champion}</Text>
                            </View>
                        )}

                        {bracket.semifinals.length > 0 && (
                            <>
                                <Text style={styles.roundLabel}>SEMIFINALS</Text>
                                {bracket.semifinals.map((m) => (
                                    <MatchupCard key={m.id} matchup={m} myMemberId={myMemberId} />
                                ))}
                            </>
                        )}

                        {bracket.final && (
                            <>
                                <Text style={styles.roundLabel}>CHAMPIONSHIP</Text>
                                <MatchupCard matchup={bracket.final} myMemberId={myMemberId} isFinal />
                            </>
                        )}
                    </ScrollView>
                )}
            </SafeAreaView>
        </>
    )
}

function MatchupCard({
    matchup,
    myMemberId,
    isFinal = false,
}: {
    matchup: BracketMatchup
    myMemberId?: string
    isFinal?: boolean
}) {
    const homeWon = matchup.isFinalized && matchup.winnerId === matchup.homeId
    const awayWon = matchup.isFinalized && matchup.winnerId === matchup.awayId
    const inProgress = !matchup.isFinalized && matchup.homePoints != null

    return (
        <View style={[styles.card, isFinal && styles.cardFinal]}>
            {/* Status pill */}
            <View style={styles.cardHeader}>
                <Text style={styles.weekLabel}>Week {matchup.weekNumber}</Text>
                <View
                    style={[
                        styles.statusPill,
                        matchup.isFinalized
                            ? styles.statusFinal
                            : inProgress
                              ? styles.statusLive
                              : styles.statusPending,
                    ]}
                >
                    <Text
                        style={[
                            styles.statusText,
                            matchup.isFinalized
                                ? styles.statusTextFinal
                                : inProgress
                                  ? styles.statusTextLive
                                  : styles.statusTextPending,
                        ]}
                    >
                        {matchup.isFinalized ? 'Final' : inProgress ? 'Live' : 'Upcoming'}
                    </Text>
                </View>
            </View>

            {/* Home team */}
            <TeamRow
                name={matchup.homeName}
                points={matchup.homePoints}
                won={homeWon}
                lost={awayWon}
                isMe={matchup.homeId === myMemberId}
            />

            <View style={styles.divider} />

            {/* Away team */}
            <TeamRow
                name={matchup.awayName}
                points={matchup.awayPoints}
                won={awayWon}
                lost={homeWon}
                isMe={matchup.awayId === myMemberId}
            />
        </View>
    )
}

function TeamRow({
    name,
    points,
    won,
    lost,
    isMe,
}: {
    name: string
    points: number | null
    won: boolean
    lost: boolean
    isMe: boolean
}) {
    return (
        <View style={[styles.teamRow, won && styles.teamRowWon, lost && styles.teamRowLost]}>
            <View style={styles.teamLeft}>
                {won && <Text style={styles.winIndicator}>▶</Text>}
                <Text
                    style={[
                        styles.teamName,
                        won && styles.teamNameWon,
                        lost && styles.teamNameLost,
                        isMe && !won && !lost && styles.teamNameMe,
                    ]}
                    numberOfLines={1}
                >
                    {name}
                    {isMe ? <Text style={styles.meTag}> (you)</Text> : null}
                </Text>
            </View>
            <Text
                style={[
                    styles.teamPoints,
                    won && styles.teamPointsWon,
                    lost && styles.teamPointsLost,
                ]}
            >
                {points != null ? points.toFixed(1) : '—'}
            </Text>
        </View>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    scroll: { padding: 16, gap: 8, paddingBottom: 40 },

    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 10 },
    emptyTitle: { fontSize: 18, fontWeight: '700', color: '#111' },
    emptyText: { fontSize: 14, color: '#aaa', textAlign: 'center', lineHeight: 20 },

    championBanner: {
        backgroundColor: '#FEF3C7',
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: '#FDE68A',
        padding: 20,
        alignItems: 'center',
        gap: 4,
        marginBottom: 8,
    },
    championLabel: { fontSize: 13, fontWeight: '800', color: '#D97706', letterSpacing: 1 },
    championName: { fontSize: 24, fontWeight: '800', color: '#111' },

    roundLabel: {
        fontSize: 11,
        fontWeight: '700',
        color: '#aaa',
        letterSpacing: 1,
        marginTop: 8,
        marginBottom: 4,
        marginLeft: 4,
    },

    card: {
        backgroundColor: '#fff',
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: '#eee',
        overflow: 'hidden',
        marginBottom: 8,
    },
    cardFinal: { borderColor: '#FDE68A', borderWidth: 1.5 },

    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: '#f3f3f3',
    },
    weekLabel: { fontSize: 12, color: '#aaa', fontWeight: '600' },

    statusPill: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 20,
        borderCurve: 'continuous' as const,
    },
    statusPending: { backgroundColor: '#f3f3f3' },
    statusLive: { backgroundColor: '#DCFCE7' },
    statusFinal: { backgroundColor: '#F3F4F6' },
    statusText: { fontSize: 11, fontWeight: '700' },
    statusTextPending: { color: '#aaa' },
    statusTextLive: { color: '#16A34A' },
    statusTextFinal: { color: '#555' },

    divider: { height: 1, backgroundColor: '#f3f3f3', marginHorizontal: 16 },

    teamRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    teamRowWon: { backgroundColor: '#F0FDF4' },
    teamRowLost: { opacity: 0.5 },
    teamLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 6 },
    winIndicator: { fontSize: 10, color: '#16A34A' },
    teamName: { fontSize: 16, fontWeight: '600', color: '#111', flex: 1 },
    teamNameWon: { color: '#15803D', fontWeight: '700' },
    teamNameLost: { color: '#999' },
    teamNameMe: { color: '#F97316' },
    meTag: { fontSize: 13, color: '#aaa', fontWeight: '400' },
    teamPoints: { fontSize: 18, fontWeight: '700', color: '#333', minWidth: 60, textAlign: 'right' },
    teamPointsWon: { color: '#15803D' },
    teamPointsLost: { color: '#bbb' },
})
