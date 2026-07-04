import {
    View,
    Text,
    ScrollView,
    StyleSheet,
    Pressable,
    useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { Stack, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { getPlayoffBracket, PlayoffBracket, BracketMatchup } from '@/lib/bracket'
import { EmptyState } from '@/components/EmptyState'
import { formatPoints } from '@/lib/format'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

export default function BracketScreen() {
    const { current, currentLeague } = useLeagueContext()
    const router = useRouter()
    const [bracket, setBracket] = useState<PlayoffBracket | null>(null)
    const { width, height } = useWindowDimensions()

    const myMemberId = current?.id
    const currentId = current?.id
    const currentLeagueId = currentLeague?.id
    const compactLandscape = width >= 600 && height < 500
    const finalMatchups = bracket?.final ? [bracket.final] : []
    const showFinalFirst = finalMatchups.length > 0 && !finalMatchups[0].isFinalized
    const showSemisFirst = !showFinalFirst && Boolean(bracket?.semifinals.some((m) => !m.isFinalized))

    useEffect(() => {
        async function load() {
            if (!currentId || !currentLeagueId) return
            try {
                const data = await getPlayoffBracket(currentLeagueId)
                setBracket(data)
            } catch (e) {
                console.error(e)
            }
        }
        load()
    }, [currentId, currentLeagueId])

    return (
        <>
            <Stack.Screen options={{ title: 'Playoff Bracket', presentation: 'modal', headerShown: false }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
                <View style={styles.screenHeader}>
                    <Pressable
                        onPress={() => router.replace('/league?tab=results')}
                        style={styles.headerBack}
                        role="link"
                        aria-label="Back to league results"
                        accessibilityRole="link"
                        accessibilityLabel="Back to league results"
                    >
                        <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
                    </Pressable>
                    <Text style={styles.screenTitle}>Playoff Bracket</Text>
                </View>
                {!bracket ||
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
                    <ScrollView contentContainerStyle={[styles.scroll, compactLandscape && styles.scrollCompact]}>
                        {bracket.champion && (
                            <View style={[styles.championBanner, compactLandscape && styles.championBannerCompact]}>
                                <Text style={styles.championLabel}>CHAMPION</Text>
                                <Text style={styles.championName}>{bracket.champion}</Text>
                            </View>
                        )}

                        {showFinalFirst ? (
                            <RoundSection label="CHAMPIONSHIP" matchups={finalMatchups} myMemberId={myMemberId} compact={compactLandscape} final />
                        ) : null}

                        {showSemisFirst ? (
                            <RoundSection label="SEMIFINALS" matchups={bracket.semifinals} myMemberId={myMemberId} compact={compactLandscape} />
                        ) : null}

                        <RoundSection label="QUARTERFINALS" matchups={bracket.quarterfinals} myMemberId={myMemberId} compact={compactLandscape} />

                        {!showSemisFirst ? (
                            <RoundSection label="SEMIFINALS" matchups={bracket.semifinals} myMemberId={myMemberId} compact={compactLandscape} />
                        ) : null}

                        {!showFinalFirst ? (
                            <RoundSection label="CHAMPIONSHIP" matchups={finalMatchups} myMemberId={myMemberId} compact={compactLandscape} final />
                        ) : null}
                    </ScrollView>
                )}
            </SafeAreaView>
        </>
    )
}

function RoundSection({
    label,
    matchups,
    myMemberId,
    compact,
    final = false,
}: {
    label: string
    matchups: BracketMatchup[]
    myMemberId?: string
    compact: boolean
    final?: boolean
}) {
    if (!matchups.length) return null

    return (
        <>
            <Text style={[styles.roundLabel, compact && styles.roundLabelCompact]}>{label}</Text>
            {matchups.map((matchup) => (
                <MatchupCard
                    key={matchup.id}
                    matchup={matchup}
                    myMemberId={myMemberId}
                    isFinal={final}
                    compact={compact}
                />
            ))}
        </>
    )
}

function MatchupCard({
    matchup,
    myMemberId,
    isFinal = false,
    compact,
}: {
    matchup: BracketMatchup
    myMemberId?: string
    isFinal?: boolean
    compact: boolean
}) {
    const homeWon = matchup.isFinalized && matchup.winnerId === matchup.homeId
    const awayWon = matchup.isFinalized && matchup.winnerId === matchup.awayId
    const inProgress = !matchup.isFinalized && matchup.homePoints != null

    return (
        <View style={[styles.card, compact && styles.cardCompact, isFinal && styles.cardFinal]}>
            <View style={[styles.cardHeader, compact && styles.cardHeaderCompact]}>
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
                compact={compact}
            />

            <View style={styles.divider} />

            <TeamRow
                name={matchup.awayName}
                points={matchup.awayPoints}
                won={awayWon}
                lost={homeWon}
                isMe={matchup.awayId === myMemberId}
                compact={compact}
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
    compact,
}: {
    name: string
    points: number | null
    won: boolean
    lost: boolean
    isMe: boolean
    compact: boolean
}) {
    return (
        <View style={[styles.teamRow, compact && styles.teamRowCompact, won && styles.teamRowWon, lost && styles.teamRowLost]}>
            <View style={styles.teamLeft}>
                {won && <Text style={styles.winIndicator}>▶</Text>}
                <Text
                    style={[
                        styles.teamName,
                        compact && styles.teamNameCompact,
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
                    compact && styles.teamPointsCompact,
                    won && styles.teamPointsWon,
                    lost && styles.teamPointsLost,
                ]}
            >
                {formatPoints(points)}
            </Text>
        </View>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgSubtle },
    screenHeader: {
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    headerBack: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    screenTitle: {
        flex: 1,
        color: colors.textPrimary,
        fontSize: fontSize.lg,
        fontWeight: fontWeight.extrabold,
    },
    scroll: { padding: spacing.xl, gap: spacing.md, paddingBottom: spacing['5xl'] },
    scrollCompact: { paddingHorizontal: spacing.md, paddingTop: spacing.md, gap: spacing.sm, paddingBottom: spacing['4xl'] },

    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing['4xl'], gap: 10 },
    emptyTitle: { fontSize: 18, fontWeight: fontWeight.bold, color: colors.textPrimary },
    emptyText: { fontSize: fontSize.md, color: colors.textPlaceholder, textAlign: 'center', lineHeight: 20 },

    championBanner: {
        backgroundColor: palette.amber300,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: palette.amber200,
        padding: spacing['2xl'],
        alignItems: 'center',
        gap: spacing.xs,
        marginBottom: spacing.md,
    },
    championBannerCompact: { padding: spacing.lg, marginBottom: spacing.sm },
    championLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: palette.amber600, letterSpacing: 0 },
    championName: { fontSize: fontSize['2xl'], fontWeight: fontWeight.extrabold, color: colors.textPrimary },

    roundLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0,
        marginTop: spacing.md,
        marginBottom: spacing.xs,
        marginLeft: spacing.xs,
    },
    roundLabelCompact: { marginTop: spacing.xs, marginBottom: 0 },

    card: {
        backgroundColor: colors.bgScreen,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        overflow: 'hidden',
        marginBottom: spacing.md,
    },
    cardCompact: { marginBottom: spacing.sm },
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
    cardHeaderCompact: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
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
    teamRowCompact: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    teamRowWon: { backgroundColor: colors.successLight },
    teamRowLost: { opacity: 0.5 },
    teamLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: spacing.sm },
    winIndicator: { fontSize: 10, color: palette.green600 },
    teamName: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold, color: colors.textPrimary, flex: 1 },
    teamNameCompact: { fontSize: fontSize.md },
    teamNameWon: { color: palette.green700, fontWeight: fontWeight.bold },
    teamNameLost: { color: palette.gray650 },
    teamNameMe: { color: colors.primaryDark },
    meTag: { fontSize: fontSize.sm, color: colors.textPlaceholder, fontWeight: fontWeight.regular },
    teamPoints: { fontSize: 18, fontWeight: fontWeight.bold, color: palette.gray900, minWidth: 60, textAlign: 'right' },
    teamPointsCompact: { fontSize: fontSize.md, minWidth: 52 },
    teamPointsWon: { color: palette.green700 },
    teamPointsLost: { color: colors.textDisabled },
})
