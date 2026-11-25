import { Badge } from '@/components/ui/Badge'
import { MotionPressable } from '@/components/Motion'
import { useDraftActivity } from '@/components/league/draft-room/useDraftActivity'
import {
    View,
    Text,
    StyleSheet,
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
import { Card } from '@/components/ui/Card'
import { SectionBand } from '@/components/ui/SectionBand'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { formatPoints } from '@/lib/format'
import { borderWidth, colors, fontWeight, layout, spacing, table, textStyles, uiColors, typeScale } from '@/constants/tokens'

type Round = { key: string; label: string; matchups: (BracketMatchup | ProjectedMatchup)[] }
type LoadStatus = 'loading' | 'ready' | 'error'

function isActualMatchup(matchup: BracketMatchup | ProjectedMatchup): matchup is BracketMatchup {
    return !('home' in matchup)
}

function roundWeeks(round: Round) {
    const actual = round.matchups.find(isActualMatchup)
    if (!actual) return null
    const endWeek = actual.endWeekNumber ?? actual.weekNumber
    return endWeek === actual.weekNumber ? `Week ${actual.weekNumber}` : `Weeks ${actual.weekNumber}–${endWeek}`
}

function roundStatus(round: Round): { label: string; color: string; textColor: string } {
    const actual = round.matchups.filter(isActualMatchup)
    if (!actual.length) return { label: 'Upcoming', color: colors.bgMuted, textColor: colors.textPlaceholder }
    if (actual.every(matchup => matchup.isFinalized)) return { label: 'Final', color: colors.bgMuted, textColor: colors.textSecondary }
    if (actual.some(matchup => !matchup.isFinalized && matchup.homePoints != null)) {
        return { label: 'Live', color: uiColors.successSurfaceStrong, textColor: uiColors.successTextLive }
    }
    return { label: 'Upcoming', color: colors.bgMuted, textColor: colors.textPlaceholder }
}

function slotName(slot: ProjectedMatchup['home']) {
    return slot.kind === 'seed'
        ? `${slot.team.seed}. ${slot.team.teamName}${slot.team.tied ? ' (tied)' : ''}`
        : slot.kind === 'winner' ? slot.label : 'Bye'
}

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
    const { padX } = usePageMetrics()

    const myMemberId = current?.id
    const currentId = current?.id
    const currentLeagueId = currentLeague?.id
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

    const rounds: Round[] = projection.kind === 'unavailable' ? [] : projection.rounds.map(round => ({ key: String(round.number), label: round.label, matchups: round.matchups }))

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
                    <ScrollView contentContainerStyle={[styles.content, { paddingHorizontal: padX }]}>
                        <Card padding="none" elevated="none" style={styles.boardCard}>
                            <SectionBand label="Playoffs" />
                            <View style={styles.emptyBody}>
                                <Text style={textStyles.rowTitle}>Playoff projection unavailable</Text>
                                <Text style={textStyles.meta}>{projection.kind === 'unavailable' ? projection.reason : ''}</Text>
                            </View>
                        </Card>
                    </ScrollView>
                ) : (
                    <ScrollView contentContainerStyle={[styles.content, { paddingHorizontal: padX }]}>
                        <Card padding="none" elevated="none" style={styles.boardCard}>
                        <SectionBand label="Playoffs" />
                        {projection.kind === 'projected' ? (
                            <View style={styles.notice}>
                                <Text style={textStyles.rowTitle}>Projected bracket — based on current standings</Text>
                                <Text style={textStyles.meta}>{`${projection.seeds.length} playoff teams · ${projection.byes.length} first-round byes${projection.byes.length ? ` (${projection.byes.map(team => `seed ${team.seed}`).join(', ')})` : ''}`}</Text>
                                {projection.unresolvedTies.map(group => (
                                    <Text key={group.seeds[0]} style={textStyles.meta}>{`Seeds ${group.seeds.join(', ')} tied, decided by tiebreaker.`}</Text>
                                ))}
                            </View>
                        ) : null}
                        {bracket?.champion ? (
                            <View style={styles.championRow}>
                                <Text style={textStyles.sectionLabel}>Champion</Text>
                                <Text style={styles.championName}>{bracket.champion}</Text>
                            </View>
                        ) : null}
                        <View style={styles.rounds}>
                            {rounds.map((round) => (
                                <RoundSection key={round.key} round={round} myMemberId={myMemberId} />
                            ))}
                        </View>
                        </Card>
                    </ScrollView>
                )}
                </View>
        </View>
    )
}

function RoundSection({ round, myMemberId }: { round: Round; myMemberId?: string }) {
    const weeks = roundWeeks(round)
    const state = roundStatus(round)
    return (
        <View>
            <SectionBand
                label={weeks ? `${round.label} · ${weeks}` : round.label}
                detail={<Badge size="status" variant="solid" label={state.label} color={state.color} textColor={state.textColor} />}
            />
            <View role="list" aria-label={`${round.label} matchups`}>
                {round.matchups.map((matchup) => (
                    isActualMatchup(matchup)
                        ? <ActualMatchupRow key={matchup.id} matchup={matchup} myMemberId={myMemberId} />
                        : <ProjectedMatchupRow key={matchup.id} matchup={matchup} />
                ))}
            </View>
        </View>
    )
}

function ActualMatchupRow({ matchup, myMemberId }: { matchup: BracketMatchup; myMemberId?: string }) {
    const router = useRouter()
    const homeWon = matchup.isFinalized && matchup.winnerId === matchup.homeId
    const awayWon = matchup.isFinalized && matchup.winnerId === matchup.awayId
    const played = matchup.homePoints != null && matchup.awayPoints != null
    const label = `Open ${matchup.homeName} versus ${matchup.awayName}`
    return (
        <MotionPressable
            style={styles.matchupRow}
            onPress={() => router.push(`/matchup?matchupId=${matchup.id}`)}
            role="button"
            accessibilityRole="button"
            aria-label={label}
            accessibilityLabel={label}
        >
            <Text numberOfLines={1} style={[styles.teamName, styles.homeName, homeWon && styles.won, awayWon && styles.lost, matchup.homeId === myMemberId && !homeWon && !awayWon && styles.me]}>{matchup.homeName}</Text>
            <Text style={styles.versus}>vs</Text>
            <Text numberOfLines={1} style={[styles.teamName, styles.awayName, awayWon && styles.won, homeWon && styles.lost, matchup.awayId === myMemberId && !homeWon && !awayWon && styles.me]}>{matchup.awayName}</Text>
            {played ? <Text style={[styles.score, homeWon && styles.scoreWon]}>{`${formatPoints(matchup.homePoints ?? 0)} – ${formatPoints(matchup.awayPoints ?? 0)}`}</Text> : null}
        </MotionPressable>
    )
}

function ProjectedMatchupRow({ matchup }: { matchup: ProjectedMatchup }) {
    return (
        <View style={styles.matchupRow} role="listitem" accessibilityLabel={`${slotName(matchup.home)} versus ${slotName(matchup.away)}`}>
            <Text numberOfLines={1} style={[styles.teamName, styles.homeName]}>{slotName(matchup.home)}</Text>
            <Text style={styles.versus}>vs</Text>
            <Text numberOfLines={1} style={[styles.teamName, styles.awayName]}>{slotName(matchup.away)}</Text>
        </View>
    )
}

const styles = StyleSheet.create({
    boardCard: { width: '100%', maxWidth: layout.formMaxWidth + 2 * layout.pagePadX.regular, alignSelf: 'center', overflow: 'hidden' },
    content: { paddingTop: spacing.md, paddingBottom: spacing.md, width: '100%', alignSelf: 'center' },
    emptyBody: { paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, gap: spacing.xs },
    notice: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.xs, borderBottomWidth: borderWidth.thin, borderBottomColor: colors.separator },
    rounds: { width: '100%' },
    matchupRow: {
        minHeight: table.rowHeight,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.borderLight,
    },
    teamName: { ...typeScale.row, fontWeight: fontWeight.semibold, color: colors.textPrimary, flex: 1, minWidth: 0 },
    homeName: { textAlign: 'right' },
    awayName: { textAlign: 'left' },
    versus: { ...typeScale.small, color: colors.textMuted, flexShrink: 0 },
    me: { color: colors.primaryDark },
    won: { color: uiColors.successTextStrong, fontWeight: fontWeight.bold },
    lost: { color: colors.textMuted },
    score: { ...typeScale.small, fontVariant: ['tabular-nums'] as const, color: colors.textSecondary, flexShrink: 0, minWidth: 88, textAlign: 'right' },
    scoreWon: { color: uiColors.successTextStrong, fontWeight: fontWeight.bold },
    championRow: {
        backgroundColor: uiColors.warningSurface,
        borderBottomWidth: borderWidth.thin,
        borderBottomColor: uiColors.warningBorder,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        gap: spacing.xxs,
    },
    championName: { ...typeScale.headline, fontWeight: fontWeight.bold, color: colors.textPrimary },
})
