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
import { EMPTY_AVG_MAP, EMPTY_STATS_MAP, getRosterStatsMaps } from '@/lib/roster-stats'
import { EmptyState } from '@/components/EmptyState'
import { ReadOnlyRosterPlayerItem, RosterSectionBand } from '@/components/roster/RosterItems'
import { Button, Page, PageHeader, usePageMetrics } from '@/components/ui'
import { colors, layout, radii, spacing, textStyles } from '@/constants/tokens'

const LINEUP_SLOT_ORDER = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE'] as const

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
    const { back, push } = useRouter()
    const { padX, compact } = usePageMetrics()
    const { memberId, teamName } = useLocalSearchParams<{ memberId: string; teamName: string }>()
    const { current, currentLeague } = useLeagueContext()
    const [roster, setRoster] = useState<RosterPlayer[]>([])
    const [avgMap, setAvgMap] = useState(EMPTY_AVG_MAP)
    const [avgStatsMap, setAvgStatsMap] = useState(EMPTY_STATS_MAP)
    const [loading, setLoading] = useState(true)
    const canProposeTrade = !!memberId && memberId !== current?.id && !isTradingClosed(currentLeague)

    useEffect(() => {
        if (!memberId || !current || !currentLeague) {
            setLoading(false)
            return
        }
        let cancelled = false
        setRoster([])
        setAvgMap(EMPTY_AVG_MAP)
        setAvgStatsMap(EMPTY_STATS_MAP)
        setLoading(true)

        void (async () => {
            const nextRoster = await getRoster(memberId, currentLeague.id)
            const stats = await getRosterStatsMaps(nextRoster.map((r) => r.players.id), currentLeague.id)
            if (cancelled) return
            setRoster(nextRoster)
            setAvgMap(stats.avgMap)
            setAvgStatsMap(stats.avgStatsMap)
        })()
            .catch(console.error)
            .finally(() => {
                if (!cancelled) setLoading(false)
            })

        return () => {
            cancelled = true
        }
    }, [memberId, current, currentLeague])

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
                {loading && roster.length === 0 ? (
                    // Blank while loading — content appears fully formed
                    // instead of swapping a loading line for the roster.
                    null
                ) : roster.length === 0 ? (
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
