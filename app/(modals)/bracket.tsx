import {
    View,
    Text,
    ScrollView,
    StyleSheet,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { getPlayoffBracket, PlayoffBracket, BracketMatchup } from '@/lib/bracket'
import { LoadingScreen } from '@/components/LoadingScreen'
import { EmptyState } from '@/components/EmptyState'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

export default function BracketScreen() {
    const { current, currentLeague } = useLeagueContext()
    const router = useRouter()
    const [bracket, setBracket] = useState<PlayoffBracket | null>(null)
    const [loading, setLoading] = useState(true)

    const myMemberId = current?.id
    const currentId = current?.id
    const currentLeagueId = currentLeague?.id

    useEffect(() => {
        async function load() {
            if (!currentId || !currentLeagueId) return
            try {
                const data = await getPlayoffBracket(currentLeagueId)
                setBracket(data)
            } catch (e) {
                console.error(e)
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [currentId, currentLeagueId])

    return (
        <>
            <Stack.Screen options={{ title: 'Playoff Bracket', presentation: 'modal' }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
                {loading ? (
                    <LoadingScreen />
                ) : !bracket ||
                  (bracket.quarterfinals.length === 0 &&
                      bracket.semifinals.length === 0 &&
                      !bracket.final) ? (
                    <EmptyState
                        icon="account-tree"
                        message="No playoff bracket yet"
                        description="The bracket is generated at the end of the regular season. Check the standings to see who's in contention."
                        actionLabel="View Standings"
                        onAction={() => router.replace('/league?tab=results')}
                    />
                ) : (
                    <ScrollView contentContainerStyle={styles.scroll}>
                        {bracket.champion && (
                            <View style={styles.championBanner}>
                                <Text style={styles.championLabel}>🏆 CHAMPION</Text>
                                <Text style={styles.championName}>{bracket.champion}</Text>
                            </View>
                        )}

                        {bracket.quarterfinals.length > 0 && (
                            <>
                                <Text style={styles.roundLabel}>QUARTERFINALS</Text>
                                {bracket.quarterfinals.map((m) => (
                                    <MatchupCard key={m.id} matchup={m} myMemberId={myMemberId} />
                                ))}
                            </>
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
    container: { flex: 1, backgroundColor: colors.bgSubtle },
    scroll: { padding: spacing.xl, gap: spacing.md, paddingBottom: spacing['5xl'] },

    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing['4xl'], gap: 10 },
    emptyTitle: { fontSize: 18, fontWeight: fontWeight.bold, color: colors.textPrimary },
    emptyText: { fontSize: fontSize.md, color: colors.textPlaceholder, textAlign: 'center', lineHeight: 20 },

    championBanner: {
        backgroundColor: palette.amber300,
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: palette.amber200,
        padding: spacing['2xl'],
        alignItems: 'center',
        gap: spacing.xs,
        marginBottom: spacing.md,
    },
    championLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: palette.amber600, letterSpacing: 1 },
    championName: { fontSize: fontSize['2xl'], fontWeight: fontWeight.extrabold, color: colors.textPrimary },

    roundLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 1,
        marginTop: spacing.md,
        marginBottom: spacing.xs,
        marginLeft: spacing.xs,
    },

    card: {
        backgroundColor: colors.bgScreen,
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        overflow: 'hidden',
        marginBottom: spacing.md,
    },
    cardFinal: { borderColor: palette.amber200, borderWidth: 1.5 },

    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.xl,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    weekLabel: { fontSize: 12, color: colors.textPlaceholder, fontWeight: fontWeight.semibold },

    statusPill: {
        paddingHorizontal: spacing.md,
        paddingVertical: 3,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
    },
    statusPending: { backgroundColor: colors.bgMuted },
    statusLive: { backgroundColor: palette.green300 },
    statusFinal: { backgroundColor: colors.bgMuted },
    statusText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold },
    statusTextPending: { color: colors.textPlaceholder },
    statusTextLive: { color: palette.green600 },
    statusTextFinal: { color: colors.textSecondary },

    divider: { height: 1, backgroundColor: colors.separator, marginHorizontal: spacing.xl },

    teamRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.xl,
        paddingVertical: 14,
    },
    teamRowWon: { backgroundColor: colors.successLight },
    teamRowLost: { opacity: 0.5 },
    teamLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: spacing.sm },
    winIndicator: { fontSize: 10, color: palette.green600 },
    teamName: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold, color: colors.textPrimary, flex: 1 },
    teamNameWon: { color: palette.green700, fontWeight: fontWeight.bold },
    teamNameLost: { color: palette.gray650 },
    teamNameMe: { color: colors.primaryDark },
    meTag: { fontSize: fontSize.sm, color: colors.textPlaceholder, fontWeight: fontWeight.regular },
    teamPoints: { fontSize: 18, fontWeight: fontWeight.bold, color: palette.gray900, minWidth: 60, textAlign: 'right' },
    teamPointsWon: { color: palette.green700 },
    teamPointsLost: { color: colors.textDisabled },
})
