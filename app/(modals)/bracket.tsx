import {
    View,
    Text,
    ScrollView,
    StyleSheet,
    useWindowDimensions,
} from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { getPlayoffBracket, PlayoffBracket, BracketMatchup } from '@/lib/bracket'
import { EmptyState } from '@/components/EmptyState'
import { ModalScreen } from '@/components/ui/ModalScreen'
import { usePageMetrics } from '@/components/ui'
import { formatPoints } from '@/lib/format'
import { colors, fontSize, fontWeight, radii, spacing, textStyles, uiColors } from '@/constants/tokens'

type Round = { key: string; label: string; matchups: BracketMatchup[]; final?: boolean }

const ROUND_COLUMN_W = 280

export default function BracketScreen() {
    const { current, currentLeague } = useLeagueContext()
    const router = useRouter()
    const resourceKey = current?.id && currentLeague?.id ? `${current.id}:${currentLeague.id}` : null
    const [resource, setResource] = useState<{ key: string | null; bracket: PlayoffBracket | null }>({
        key: resourceKey,
        bracket: null,
    })
    const requestRef = useRef(0)
    const bracket = resource.key === resourceKey ? resource.bracket : null
    const { width, height } = useWindowDimensions()
    const { padX, usableWidth } = usePageMetrics()

    const myMemberId = current?.id
    const currentId = current?.id
    const currentLeagueId = currentLeague?.id
    const compactLandscape = width >= 600 && height < 500
    const finalMatchups = bracket?.final ? [bracket.final] : []

    useEffect(() => {
        const requestId = ++requestRef.current
        setResource({ key: resourceKey, bracket: null })
        async function load() {
            if (!currentId || !currentLeagueId) return
            try {
                const data = await getPlayoffBracket(currentLeagueId)
                if (requestRef.current === requestId) setResource({ key: resourceKey, bracket: data })
            } catch (e) {
                if (requestRef.current === requestId) console.error(e)
            }
        }
        load()
        return () => { requestRef.current += 1 }
    }, [currentId, currentLeagueId, resourceKey])

    const backToStandings = () => router.replace('/league?tab=results')
    const rounds: Round[] = bracket ? [
        { key: 'qf', label: 'Quarterfinals', matchups: bracket.quarterfinals },
        { key: 'sf', label: 'Semifinals', matchups: bracket.semifinals },
        { key: 'final', label: 'Championship', matchups: finalMatchups, final: true },
    ].filter((round) => round.matchups.length > 0) : []
    // Wide screens draw the real bracket, rounds left to right. Narrow screens
    // stack rounds and lead with the one still being played.
    const columns = rounds.length > 1 && usableWidth >= rounds.length * ROUND_COLUMN_W + (rounds.length - 1) * spacing['3xl']
    const liveIndex = rounds.findIndex((round) => round.matchups.some((matchup) => !matchup.isFinalized))
    const stacked = liveIndex > 0 ? [rounds[liveIndex], ...rounds.filter((_, index) => index !== liveIndex)] : rounds

    return (
        <>
            <Stack.Screen options={{ title: 'Playoffs', presentation: 'modal', headerShown: false }} />
            <ModalScreen title="Playoffs" onBack={backToStandings} backLabel="Back to league standings">
                {rounds.length === 0 ? (
                    <EmptyState
                        icon="account-tree"
                        message="No playoff bracket yet"
                        description="It appears when the regular season ends."
                        actionLabel="View Standings"
                        onAction={backToStandings}
                    />
                ) : (
                    <ScrollView contentContainerStyle={[styles.scroll, { paddingHorizontal: padX }, compactLandscape && styles.scrollCompact]}>
                        {bracket?.champion ? (
                            <View style={[styles.championBanner, compactLandscape && styles.championBannerCompact]}>
                                <Text style={textStyles.sectionLabel}>Champion</Text>
                                <Text style={styles.championName}>{bracket.champion}</Text>
                            </View>
                        ) : null}
                        {columns ? (
                            <View style={styles.columns}>
                                {rounds.map((round) => (
                                    <View key={round.key} style={styles.column}>
                                        <RoundSection round={round} myMemberId={myMemberId} compact={compactLandscape} inColumn />
                                    </View>
                                ))}
                            </View>
                        ) : (
                            <View style={styles.stack}>
                                {stacked.map((round) => (
                                    <RoundSection key={round.key} round={round} myMemberId={myMemberId} compact={compactLandscape} />
                                ))}
                            </View>
                        )}
                    </ScrollView>
                )}
            </ModalScreen>
        </>
    )
}

function RoundSection({ round, myMemberId, compact, inColumn = false }: { round: Round; myMemberId?: string; compact: boolean; inColumn?: boolean }) {
    return (
        <View style={[styles.round, inColumn && styles.roundInColumn]}>
            <Text style={[textStyles.sectionLabel, styles.roundLabel]} role="heading" aria-level={2} accessibilityRole="header">
                {round.label}
            </Text>
            <View style={[styles.roundCards, inColumn && styles.roundCardsInColumn]}>
                {round.matchups.map((matchup) => (
                    <MatchupCard
                        key={matchup.id}
                        matchup={matchup}
                        myMemberId={myMemberId}
                        isFinal={round.final}
                        compact={compact}
                    />
                ))}
            </View>
        </View>
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
    scroll: { paddingTop: spacing.xl, paddingBottom: spacing['5xl'], gap: spacing.lg, width: '100%', maxWidth: 3 * ROUND_COLUMN_W + 2 * spacing['3xl'] + 2 * spacing['3xl'], alignSelf: 'center' },
    scrollCompact: { paddingTop: spacing.md, gap: spacing.sm, paddingBottom: spacing['4xl'] },
    stack: { gap: spacing.lg },
    columns: { flexDirection: 'row', alignItems: 'stretch', gap: spacing['3xl'] },
    column: { flex: 1, minWidth: 0 },
    round: { gap: spacing.sm },
    roundInColumn: { flex: 1 },
    roundCards: { gap: spacing.md },
    // In bracket columns the later rounds center between the games feeding them.
    roundCardsInColumn: { flex: 1, justifyContent: 'space-around' },
    roundLabel: { marginLeft: spacing.xs },

    championBanner: {
        backgroundColor: uiColors.warningSurface,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: uiColors.warningBorder,
        padding: spacing['2xl'],
        alignItems: 'center',
        gap: spacing.xs,
    },
    championBannerCompact: { padding: spacing.lg },
    championName: { fontSize: fontSize['2xl'], fontWeight: fontWeight.bold, color: colors.textPrimary },

    card: {
        backgroundColor: colors.bgCard,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        overflow: 'hidden',
    },
    cardCompact: {},
    cardFinal: { borderColor: uiColors.warningBorder, borderWidth: 1.5 },

    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    cardHeaderCompact: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
    weekLabel: { ...textStyles.meta, fontWeight: fontWeight.semibold },

    statusPill: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xxs,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
    },
    statusPending: { backgroundColor: colors.bgMuted },
    statusLive: { backgroundColor: uiColors.successSurfaceStrong },
    statusFinal: { backgroundColor: colors.bgMuted },
    statusText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold },
    statusTextPending: { color: colors.textPlaceholder },
    statusTextLive: { color: uiColors.successTextLive },
    statusTextFinal: { color: colors.textSecondary },

    divider: { height: 1, backgroundColor: colors.separator, marginHorizontal: spacing.lg },

    teamRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        minHeight: 48,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
    },
    teamRowCompact: { minHeight: 40, paddingVertical: spacing.xs },
    teamRowWon: { backgroundColor: colors.successLight },
    teamRowLost: {},
    teamLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: spacing.sm },
    winIndicator: { fontSize: fontSize['2xs'], color: uiColors.successTextLive },
    teamName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary, flex: 1 },
    teamNameCompact: { fontSize: fontSize.md },
    teamNameWon: { color: uiColors.successTextStrong, fontWeight: fontWeight.bold },
    teamNameLost: { color: colors.textMuted },
    teamNameMe: { color: colors.primaryDark },
    meTag: { fontSize: fontSize.sm, color: colors.textPlaceholder, fontWeight: fontWeight.regular },
    teamPoints: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: uiColors.tableText, minWidth: 60, textAlign: 'right', fontVariant: ['tabular-nums'] as const },
    teamPointsCompact: { fontSize: fontSize.md, minWidth: 52 },
    teamPointsWon: { color: uiColors.successTextStrong },
    teamPointsLost: { color: colors.textMuted },
})
