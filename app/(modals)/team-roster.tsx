import { DeferredContent } from '@/components/ui/DeferredContent'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { useDraftActivity as useModalActivity } from '@/components/league/draft-room/useDraftActivity'
import {
    View,
    Text,
    ScrollView,
    StyleSheet,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { isTradingClosed } from '@/lib/league'
import { listenForLeagueChanges } from '@/lib/league-changes'
import { getRoster, RosterPlayer } from '@/lib/roster'
import { EMPTY_AVG_MAP, EMPTY_STATS_MAP, getRosterStatsMaps, type RosterAverage, type RosterStatsMaps } from '@/lib/roster-stats'
import { EmptyState } from '@/components/EmptyState'
import { ReadOnlyRosterPlayerItem, RosterSectionBand } from '@/components/roster/RosterItems'
import { Button, ErrorBanner, LoadingState, Page, PageHeader, usePageMetrics } from '@/components/ui'
import { colors, controlSize, layout, radii, spacing, textStyles } from '@/constants/tokens'
import { useGoBack } from '@/components/ui/useGoBack'

const LINEUP_SLOT_ORDER = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE'] as const
const EMPTY_ROSTER: RosterPlayer[] = []
type TeamRosterCache = { roster: RosterPlayer[]; averages: [string, number][]; stats: [string, RosterAverage][] }

function readRosterResource(scope: string | null) {
    const cached = scope ? readPersistentCache<TeamRosterCache>(`pancake:team-roster:v1:${scope}`) : null
    return cached && scope ? { scope, roster: cached.roster, stats: { avgMap: new Map(cached.averages), avgStatsMap: new Map(cached.stats) } } : null
}

function rosterSlotRank(player: RosterPlayer): number {
    const eligible = player.players.eligible_positions?.length
        ? player.players.eligible_positions
        : player.players.position
          ? [player.players.position]
          : []
    const rank = LINEUP_SLOT_ORDER.findIndex((slot) => eligible.includes(slot))
    return rank === -1 ? LINEUP_SLOT_ORDER.length : rank
}

function compareRosterBySlot(a: RosterPlayer, b: RosterPlayer): number {
    const slotCmp = rosterSlotRank(a) - rosterSlotRank(b)
    if (slotCmp !== 0) return slotCmp
    return (a.players.display_name ?? '').localeCompare(b.players.display_name ?? '')
}

export default function TeamRosterScreen() {
    const { push } = useRouter()
    const back = useGoBack('/league')
    const { padX, compact } = usePageMetrics()
    const { memberId, teamName } = useLocalSearchParams<{ memberId: string; teamName: string }>()
    const { current, currentLeague, membershipStatus, refresh } = useLeagueContext()
    const scope = memberId && current && currentLeague ? `${current.id}:${currentLeague.id}:${memberId}` : null
    const leagueId = currentLeague?.id
    const { canRead, capture, isCurrent, epoch } = useModalActivity(scope)
    const [resource, setResource] = useState<{ scope: string; roster: RosterPlayer[]; stats: RosterStatsMaps } | null>(() => readRosterResource(scope))
    const [loading, setLoading] = useState(true)
    const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null)
    const [attempt, setAttempt] = useState(0)
    const ownsRoster = scope !== null && resource?.scope === scope
    const roster = ownsRoster ? resource.roster : EMPTY_ROSTER
    const { avgMap, avgStatsMap } = ownsRoster ? resource.stats : { avgMap: EMPTY_AVG_MAP, avgStatsMap: EMPTY_STATS_MAP }
    const loadError = failure?.scope === scope ? failure.message : null
    const canProposeTrade = !!scope && memberId !== current?.id && !isTradingClosed(currentLeague)

    useEffect(() => {
        setResource(readRosterResource(scope))
    }, [scope])

    useEffect(() => {
        if (!leagueId || !memberId || !scope) return
        return listenForLeagueChanges(leagueId, change => {
            if (change.topic !== 'roster' && change.topic !== 'inventory') return
            if (change.scopes && !change.scopes.some(row => !row.member_id || row.member_id === memberId)) return
            setAttempt(value => value + 1)
        })
    }, [leagueId, memberId, scope])

    useEffect(() => {
        if (!memberId || !leagueId || !scope) {
            setLoading(false)
            return
        }
        if (!canRead()) return
        const generation = capture()
        let cancelled = false
        setFailure(null)
        setLoading(true)
        let rosterLoaded = false

        void (async () => {
            const nextRoster = await getRoster(memberId, leagueId)
            if (cancelled || !isCurrent(generation)) return
            rosterLoaded = true
            let stats: RosterStatsMaps
            try {
                stats = await getRosterStatsMaps(nextRoster.map((r) => r.players.id), leagueId)
            } catch (error) {
                if (!cancelled && isCurrent(generation)) setResource((previous) => previous?.scope === scope ? previous : {
                    scope, roster: nextRoster, stats: { avgMap: EMPTY_AVG_MAP, avgStatsMap: EMPTY_STATS_MAP },
                })
                throw error
            }
            if (cancelled || !isCurrent(generation)) return
            writePersistentCache<TeamRosterCache>(`pancake:team-roster:v1:${scope}`, { roster: nextRoster, averages: [...stats.avgMap], stats: [...stats.avgStatsMap] })
            setResource({ scope, roster: nextRoster, stats })
        })()
            .catch((error) => {
                console.error(error)
                if (!cancelled && isCurrent(generation)) setFailure({ scope, message: rosterLoaded
                    ? 'Failed to load player averages. Tap to retry.'
                    : 'Failed to load roster. Tap to retry.' })
            })
            .finally(() => {
                if (!cancelled && isCurrent(generation)) setLoading(false)
            })

        return () => {
            cancelled = true
        }
    }, [memberId, leagueId, scope, attempt, canRead, capture, isCurrent, epoch])

    const active = useMemo(
        () => roster.filter((r) => !r.is_on_ir && !r.is_on_taxi).sort(compareRosterBySlot),
        [roster],
    )
    const ir = useMemo(
        () => roster.filter((r) => r.is_on_ir).sort(compareRosterBySlot),
        [roster],
    )
    const taxi = useMemo(
        () => roster.filter((r) => r.is_on_taxi).sort(compareRosterBySlot),
        [roster],
    )

    const renderSection = (label: string, items: RosterPlayer[], capacity: number, empty: string, tone?: 'taxi') => {
        const size = Math.max(items.length, capacity)
        if (size === 0) return null
        return (
            <View style={styles.card}>
                <RosterSectionBand label={label} tone={tone} />
                {items.map((item, index) => (
                    <View key={item.id} style={index < size - 1 ? styles.rowDivider : undefined}>
                        <ReadOnlyRosterPlayerItem
                            item={item}
                            avgFpts={avgMap.get(item.players.id)}
                            avgMinutes={avgStatsMap.get(item.players.id)?.avg_minutes_played}
                            onPress={() => push({ pathname: '/player/[id]', params: { id: item.players.id } })}
                        />
                    </View>
                ))}
                {Array.from({ length: Math.max(0, capacity - items.length) }, (_, index) => (
                    <View key={`empty-${index}`} style={[styles.emptySlot, items.length + index < size - 1 && styles.rowDivider]}>
                        <Text style={styles.emptySlotText}>{empty}</Text>
                    </View>
                ))}
            </View>
        )
    }

    return (
        <Page title={teamName ?? 'Team roster'}>
            <PageHeader
                title={teamName ?? 'Team roster'}
                reserveMeta
                meta={roster.length > 0
                    ? `${active.length} active${ir.length > 0 ? ` · ${ir.length} IR` : ''}${taxi.length > 0 ? ` · ${taxi.length} taxi` : ''}`
                    : undefined}
                onBack={() => back()}
                backLabel="Close team roster"
                actions={canProposeTrade ? (
                    <Button
                        title={compact ? 'Trade' : 'Propose trade'}
                        size="sm"
                        onPress={() => push({ pathname: '/(modals)/propose-trade', params: { recipientMemberId: memberId } })}
                        accessibilityLabel={`Propose trade with ${teamName ?? 'this team'}`}
                    />
                ) : null}
            />

            <ScrollView
                style={styles.list}
                aria-busy={loading}
                accessibilityState={{ busy: loading }}
                contentContainerStyle={[styles.listContent, { paddingHorizontal: padX }]}
            >
                {loadError ? <ErrorBanner message={loadError} onRetry={() => setAttempt((value) => value + 1)} /> : null}
                <DeferredContent ready={ownsRoster || Boolean(loadError) || !memberId || !scope}>
                {!memberId ? (
                    <Text>Choose a team to view its roster.</Text>
                ) : !scope ? (
                    membershipStatus === 'loading' ? <LoadingState />
                        : membershipStatus === 'unavailable'
                            ? <ErrorBanner message="League access is unavailable. Tap to retry." onRetry={() => { void refresh() }} />
                            : <Text>Join a league to view team rosters.</Text>
                ) : (!ownsRoster && !loadError) || (loading && !ownsRoster) ? (
                    <LoadingState />
                ) : ownsRoster ? (
                    <>
                        {roster.length === 0 && !loadError ? (
                            <EmptyState
                                icon="sports-basketball"
                                message="No players yet"
                                description="This roster fills as the draft and season go on."
                                fullScreen={false}
                                framed
                            />
                        ) : null}
                        {renderSection('Active roster', active, currentLeague?.roster_size ?? 0, 'Empty roster slot')}
                        {renderSection('Injured reserve', ir, currentLeague?.ir_slots ?? 0, 'Empty IR slot')}
                        {renderSection('Taxi squad', taxi, currentLeague?.taxi_slots ?? 0, 'Empty taxi slot', 'taxi')}
                    </>
                ) : null}
                </DeferredContent>
            </ScrollView>
        </Page>
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

const styles = StyleSheet.create({

    list: { flex: 1 },
    listContent: { width: '100%', maxWidth: layout.formMaxWidth, alignSelf: 'center', paddingVertical: spacing.md, gap: spacing.md },
    card: {
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        overflow: 'hidden',
    },
    rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.separator },
    emptySlot: {
        minHeight: controlSize.minTouch,
        justifyContent: 'center',
        paddingHorizontal: spacing.lg,
    },
    emptySlotText: { ...textStyles.meta, color: colors.textPlaceholder, fontStyle: 'italic' },
})
