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
import { getRoster, RosterPlayer } from '@/lib/roster'
import { EMPTY_AVG_MAP, EMPTY_STATS_MAP, getRosterStatsMaps, type RosterStatsMaps } from '@/lib/roster-stats'
import { EmptyState } from '@/components/EmptyState'
import { ReadOnlyRosterPlayerItem, RosterSectionBand } from '@/components/roster/RosterItems'
import { Button, ErrorBanner, LoadingState, Page, PageHeader, usePageMetrics } from '@/components/ui'
import { colors, layout, radii, spacing, textStyles } from '@/constants/tokens'
import { useGoBack } from '@/components/ui/useGoBack'

const LINEUP_SLOT_ORDER = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE'] as const
const EMPTY_ROSTER: RosterPlayer[] = []

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
    const [resource, setResource] = useState<{ scope: string; roster: RosterPlayer[]; stats: RosterStatsMaps } | null>(null)
    const [loading, setLoading] = useState(true)
    const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null)
    const [attempt, setAttempt] = useState(0)
    const ownsRoster = scope !== null && resource?.scope === scope
    const roster = ownsRoster ? resource.roster : EMPTY_ROSTER
    const { avgMap, avgStatsMap } = ownsRoster ? resource.stats : { avgMap: EMPTY_AVG_MAP, avgStatsMap: EMPTY_STATS_MAP }
    const loadError = failure?.scope === scope ? failure.message : null
    const canProposeTrade = !!scope && memberId !== current?.id && !isTradingClosed(currentLeague)

    useEffect(() => {
        if (!memberId || !currentLeague || !scope) {
            setLoading(false)
            return
        }
        let cancelled = false
        setFailure(null)
        setLoading(true)
        let rosterLoaded = false

        void (async () => {
            const nextRoster = await getRoster(memberId, currentLeague.id)
            if (cancelled) return
            rosterLoaded = true
            setResource((previous) => ({
                scope, roster: nextRoster,
                stats: previous?.scope === scope ? previous.stats : { avgMap: EMPTY_AVG_MAP, avgStatsMap: EMPTY_STATS_MAP },
            }))
            const stats = await getRosterStatsMaps(nextRoster.map((r) => r.players.id), currentLeague.id)
            if (cancelled) return
            setResource((previous) => previous?.scope === scope ? { ...previous, stats } : previous)
        })()
            .catch((error) => {
                console.error(error)
                if (!cancelled) setFailure({ scope, message: rosterLoaded
                    ? 'Failed to load player averages. Tap to retry.'
                    : 'Failed to load roster. Tap to retry.' })
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })

        return () => {
            cancelled = true
        }
    }, [memberId, currentLeague, scope, attempt])

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

    const renderSection = (label: string, items: RosterPlayer[], empty?: string, tone?: 'taxi') => (
        <View style={styles.card}>
            <RosterSectionBand label={label} tone={tone} />
            {items.length === 0 && empty ? (
                <View style={styles.taxiEmpty}>
                    <Text style={styles.taxiEmptyText}>{empty}</Text>
                </View>
            ) : items.map((item, index) => (
                <View key={item.id} style={index < items.length - 1 ? styles.rowDivider : undefined}>
                    <ReadOnlyRosterPlayerItem
                        item={item}
                        avgFpts={avgMap.get(item.players.id)}
                        avgMinutes={avgStatsMap.get(item.players.id)?.avg_minutes_played}
                        onPress={() => push({ pathname: '/player/[id]', params: { id: item.players.id } })}
                    />
                </View>
            ))}
        </View>
    )

    return (
        <Page title={teamName ?? 'Team roster'}>
            <PageHeader
                title={teamName ?? 'Team roster'}
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
                contentContainerStyle={[styles.listContent, { paddingHorizontal: padX }]}
            >
                {loadError ? <ErrorBanner message={loadError} onRetry={() => setAttempt((value) => value + 1)} /> : null}
                {!memberId ? (
                    <Text>Choose a team to view its roster.</Text>
                ) : !scope ? (
                    membershipStatus === 'loading' ? <LoadingState />
                        : membershipStatus === 'unavailable'
                            ? <ErrorBanner message="League access is unavailable. Tap to retry." onRetry={() => { void refresh() }} />
                            : <Text>Join a league to view team rosters.</Text>
                ) : (!ownsRoster && !loadError) || (loading && roster.length === 0) ? (
                    <LoadingState />
                ) : roster.length === 0 ? (
                    loadError ? null :
                    <EmptyState
                        icon="sports-basketball"
                        message="No players yet"
                        description="This roster fills as the draft and season go on."
                        fullScreen={false}
                        framed
                    />
                ) : (
                    <>
                        {renderSection('Active roster', active)}
                        {ir.length > 0 ? renderSection('Injured reserve', ir) : null}
                        {renderSection('Taxi squad', taxi, 'No players on taxi squad', 'taxi')}
                    </>
                )}
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
    taxiEmpty: {
        minHeight: 44,
        justifyContent: 'center',
        paddingHorizontal: spacing.lg,
    },
    taxiEmptyText: { ...textStyles.meta, color: colors.textPlaceholder, fontStyle: 'italic' },
})
