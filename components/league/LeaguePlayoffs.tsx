import { Badge } from '@/components/ui/Badge'
import { MotionPressable } from '@/components/Motion'
import { useDraftActivity } from '@/components/league/draft-room/useDraftActivity'
import {
    View,
    Text,
    StyleSheet,
    useWindowDimensions,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { getPlayoffBracket, PlayoffBracket, BracketMatchup } from '@/lib/bracket'
import { ScreenStatusScrollView as ScrollView } from '@/components/ui/ScreenStatusOverlay'
import { EmptyState } from '@/components/EmptyState'
import { projectPlayoffs, type ProjectedMatchup } from '@/lib/playoff-projection'
import type { StandingRow } from '@/lib/scoring'
import { ErrorBanner, LoadingState, usePageMetrics } from '@/components/ui'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { formatPoints } from '@/lib/format'
import { colors, fontSize, fontWeight, layout, radii, spacing, textStyles, uiColors } from '@/constants/tokens'

type Round = { key: string; label: string; matchups: (BracketMatchup | ProjectedMatchup)[]; final?: boolean }
type LoadStatus = 'loading' | 'ready' | 'error'

const ROUND_COLUMN_W = 280

export function LeaguePlayoffs({ standings, playoffEntrants }: { standings: StandingRow[]; playoffEntrants: number | null | undefined }) {
    const { current, currentLeague } = useLeagueContext()
    const resourceKey = current?.id && currentLeague?.id ? `${current.id}:${currentLeague.id}` : null
    const { canRead, capture, isCurrent, epoch } = useDraftActivity(resourceKey)
    const cacheKey = `pancake:bracket:v1:${resourceKey}`
    const [resource, setResource] = useState<{ key: string | null; bracket: PlayoffBracket | null; status: LoadStatus }>(() => {
        const cached = resourceKey ? readPersistentCache<{ bracket: PlayoffBracket | null }>(cacheKey) : undefined
        return { key: resourceKey, bracket: cached?.bracket ?? null, status: cached ? 'ready' : 'loading' }
    })
    const [refreshError, setRefreshError] = useState(false)
    const [refreshing, setRefreshing] = useState(false)
    const [attempt, setAttempt] = useState(0)
    const requestRef = useRef(0)
    const bracket = resource.key === resourceKey ? resource.bracket : null
    const status: LoadStatus = resource.key === resourceKey ? resource.status : 'loading'
    const { width, height } = useWindowDimensions()
    const { padX, usableWidth } = usePageMetrics()

    const myMemberId = current?.id
    const currentId = current?.id
    const currentLeagueId = currentLeague?.id
    const compactLandscape = width >= 600 && height < 500
    const projection = projectPlayoffs(standings, currentLeague ? { playoffEntrants: playoffEntrants ?? null } : null, bracket)

    useEffect(() => {
        const requestId = ++requestRef.current
        if (!canRead()) return
        const generation = capture()
        setRefreshing(true)
        setRefreshError(false)
        setResource(previous => {
            if (previous.key === resourceKey && previous.status === 'ready') return previous
            const cached = resourceKey ? readPersistentCache<{ bracket: PlayoffBracket | null }>(cacheKey) : undefined
            return { key: resourceKey, bracket: cached?.bracket ?? null, status: cached ? 'ready' : 'loading' }
        })
        async function load() {
            if (!currentId || !currentLeagueId) {
                setResource({ key: resourceKey, bracket: null, status: 'ready' })
                setRefreshing(false)
                return
            }
            try {
                const data = await getPlayoffBracket(currentLeagueId)
                if (requestRef.current === requestId && isCurrent(generation)) {
                    writePersistentCache(cacheKey, { bracket: data })
                    setResource({ key: resourceKey, bracket: data, status: 'ready' })
                }
            } catch (e) {
                if (requestRef.current !== requestId || !isCurrent(generation)) return
                console.error(e)
                setRefreshError(true)
                setResource(previous => previous.key === resourceKey && previous.status === 'ready' ? previous : { key: resourceKey, bracket: null, status: 'error' })
            } finally {
                if (requestRef.current === requestId && isCurrent(generation)) setRefreshing(false)
            }
        }
        load()
        return () => { requestRef.current += 1 }
    }, [attempt, currentId, currentLeagueId, resourceKey, canRead, capture, isCurrent, epoch, cacheKey, standings])

    const rounds: Round[] = projection.kind === 'unavailable' ? [] : projection.rounds.map(round => ({ key: String(round.number), label: round.label, matchups: round.matchups, final: round.label === 'Championship' }))
    const columns = rounds.length > 1 && usableWidth >= rounds.length * ROUND_COLUMN_W + (rounds.length - 1) * spacing['3xl']
    const liveIndex = rounds.findIndex((round) => round.matchups.some((matchup) => !('home' in matchup) && !matchup.isFinalized))
    const stacked = liveIndex > 0 ? [rounds[liveIndex], ...rounds.filter((_, index) => index !== liveIndex)] : rounds

    return (
        <View style={{ flex: 1 }}>
                {refreshError && status !== 'error' ? <ErrorBanner message="Could not refresh the bracket." onRetry={() => setAttempt(value => value + 1)} /> : null}
                <View style={{ flex: 1, minHeight: 320 }} aria-busy={refreshing} accessibilityState={{ busy: refreshing }}>
                {status === 'loading' ? <LoadingState /> : status === 'error' ? (
                    <EmptyState
                        icon="cloud-off"
                        message="Couldn't load the bracket"
                        description="Check your connection, then try again."
                        actionLabel="Try Again"
                        onAction={() => setAttempt((value) => value + 1)}
                    />
                ) : rounds.length === 0 ? (
                    <View style={[styles.emptyBracket, { paddingHorizontal: padX }]}>
                        <Text style={textStyles.rowTitle}>Playoff projection unavailable</Text>
                        <Text style={textStyles.body}>{projection.kind === 'unavailable' ? projection.reason : ''}</Text>
                    </View>
                ) : (
                    <ScrollView contentContainerStyle={[styles.scroll, { paddingHorizontal: padX, maxWidth: rounds.length * ROUND_COLUMN_W + (rounds.length - 1) * spacing['3xl'] + 2 * padX }, compactLandscape && styles.scrollCompact]}>
                        {projection.kind === 'projected' ? (
                            <View style={{ gap: spacing.sm }}>
                                <Text style={textStyles.rowTitle}>Projected bracket — based on current standings</Text>
                                <Text style={textStyles.body}>{`${projection.seeds.length} playoff teams · ${projection.byes.length} first-round byes${projection.byes.length ? ` (${projection.byes.map(team => `seed ${team.seed}`).join(', ')})` : ''}`}</Text>
                                <Text style={textStyles.meta}>Seeds use win percentage, points per game, max points, then fewest points against.</Text>
                                {projection.unresolvedTies.map(group => (
                                    <Text key={group.seeds[0]} style={textStyles.body}>{`Seeds ${group.seeds.join(', ')} tied, decided by tiebreaker. ${group.teams.map(team => team.teamName).join(', ')} have provisional positions.`}</Text>
                                ))}
                            </View>
                        ) : null}
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
                </View>
        </View>
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
    matchup: BracketMatchup | ProjectedMatchup
    myMemberId?: string
    isFinal?: boolean
    compact: boolean
}) {
    const router = useRouter()
    if ('home' in matchup) return <ProjectedMatchupCard matchup={matchup} compact={compact} isFinal={isFinal} />
    const homeWon = matchup.isFinalized && matchup.winnerId === matchup.homeId
    const awayWon = matchup.isFinalized && matchup.winnerId === matchup.awayId
    const inProgress = !matchup.isFinalized && matchup.homePoints != null

    return (
        <MotionPressable style={[styles.card, compact && styles.cardCompact, isFinal && styles.cardFinal]}
            onPress={() => router.push(`/matchup?matchupId=${matchup.id}`)}
            role="button" accessibilityRole="button"
            aria-label={`Open ${matchup.homeName} versus ${matchup.awayName}`}
            accessibilityLabel={`Open ${matchup.homeName} versus ${matchup.awayName}`}>
            <View style={[styles.cardHeader, compact && styles.cardHeaderCompact]}>
                <Text style={styles.weekLabel}>{(matchup.endWeekNumber ?? matchup.weekNumber) === matchup.weekNumber
                    ? `Week ${matchup.weekNumber}` : `Weeks ${matchup.weekNumber}–${matchup.endWeekNumber}`}</Text>
                <Badge size="status" variant="solid"
                    label={matchup.isFinalized ? 'Final' : inProgress ? 'Live' : 'Upcoming'}
                    color={!matchup.isFinalized && inProgress ? uiColors.successSurfaceStrong : colors.bgMuted}
                    textColor={matchup.isFinalized ? colors.textSecondary : inProgress ? uiColors.successTextLive : colors.textPlaceholder}
                />
            </View>

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
        </MotionPressable>
    )
}

function ProjectedMatchupCard({ matchup, compact, isFinal }: { matchup: ProjectedMatchup; compact: boolean; isFinal: boolean }) {
    const slotName = (slot: ProjectedMatchup['home']) => slot.kind === 'seed' ? `${slot.team.seed}. ${slot.team.teamName}${slot.team.tied ? ' (tied)' : ''}` : slot.kind === 'winner' ? slot.label : 'Bye'
    return (
        <View style={[styles.card, compact && styles.cardCompact, isFinal && styles.cardFinal]}>
            <View style={styles.cardHeader}>
                <Text style={styles.weekLabel}>{matchup.bye ? 'First-round bye' : 'Projected matchup'}</Text>
            </View>
            <TeamRow name={slotName(matchup.home)} points={null} won={false} lost={false} isMe={false} compact={compact} projected />
            <View style={styles.divider} />
            <TeamRow name={slotName(matchup.away)} points={null} won={false} lost={false} isMe={false} compact={compact} projected />
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
    projected = false,
}: {
    name: string
    points: number | null
    won: boolean
    lost: boolean
    isMe: boolean
    compact: boolean
    projected?: boolean
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
            {!projected ? <Text
                style={[
                    styles.teamPoints,
                    compact && styles.teamPointsCompact,
                    won && styles.teamPointsWon,
                    lost && styles.teamPointsLost,
                ]}
            >
                {formatPoints(points)}
            </Text> : null}
        </View>
    )
}

const styles = StyleSheet.create({
    emptyBracket: { width: '100%', maxWidth: layout.formMaxWidth, alignSelf: 'center', paddingTop: spacing.lg, gap: spacing.sm },
    scroll: { paddingTop: spacing.xl, paddingBottom: spacing['5xl'], gap: spacing.lg, width: '100%', alignSelf: 'center' },
    scrollCompact: { paddingTop: spacing.md, gap: spacing.sm, paddingBottom: spacing['4xl'] },
    stack: { gap: spacing.lg },
    columns: { flexDirection: 'row', alignItems: 'stretch', gap: spacing['3xl'] },
    column: { flex: 1, minWidth: 0 },
    round: { gap: spacing.sm },
    roundInColumn: { flex: 1 },
    roundCards: { gap: spacing.md },
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
