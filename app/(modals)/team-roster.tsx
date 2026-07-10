import {
    View,
    Text,
    Pressable,
    ScrollView,
    StyleSheet,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { isTradingClosed } from '@/lib/league'
import { getRoster, RosterPlayer } from '@/lib/roster'
import { EMPTY_AVG_MAP, EMPTY_STATS_MAP, getRosterStatsMaps } from '@/lib/roster-stats'
import { EmptyState } from '@/components/EmptyState'
import { SectionHeader } from '@/components/SectionHeader'
import { ReadOnlyRosterPlayerItem } from '@/components/roster/RosterItems'
import { colors, fontSize, fontWeight, spacing } from '@/constants/tokens'

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

    const renderRosterRows = (items: RosterPlayer[]) => items.map((item, index) => (
        <View key={item.id}>
            <ReadOnlyRosterPlayerItem
                item={item}
                avgFpts={avgMap.get(item.players.id)}
                avgMinutes={avgStatsMap.get(item.players.id)?.avg_minutes_played}
                onPress={() => push({ pathname: '/player/[id]', params: { id: item.players.id } })}
            />
            {index < items.length - 1 ? <View style={styles.separator} /> : null}
        </View>
    ))

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <View style={styles.header}>
                <View style={styles.headerInner}>
                    <Pressable
                        onPress={() => back()}
                        style={styles.closeButton}
                        accessibilityRole="button"
                        accessibilityLabel="Close team roster"
                    >
                        <Text style={styles.closeText}>Done</Text>
                    </Pressable>
                    <Text style={styles.headerTitle} numberOfLines={1}>{teamName ?? 'Roster'}</Text>
                    {canProposeTrade ? (
                        <Pressable
                            onPress={() => push({ pathname: '/(modals)/propose-trade', params: { recipientMemberId: memberId } })}
                            style={styles.closeButton}
                            accessibilityRole="button"
                            accessibilityLabel={`Propose trade with ${teamName ?? 'this team'}`}
                        >
                            <Text style={styles.closeText}>Trade</Text>
                        </Pressable>
                    ) : (
                        <View style={styles.closeButton} />
                    )}
                </View>
            </View>

            <ScrollView
                style={styles.list}
                contentContainerStyle={styles.listContent}
            >
                {loading && roster.length === 0 ? (
                    // Blank while loading — content appears fully formed
                    // instead of swapping a loading line for the roster.
                    null
                ) : roster.length === 0 ? (
                    <EmptyState
                        icon="sports-basketball"
                        message="No players yet"
                        description="This team's roster fills as the draft and season unfold. Check back once the draft is underway."
                        fullScreen={false}
                        framed
                    />
                ) : (
                    <>
                        <View style={styles.countRow}>
                            <Text style={styles.countText}>
                                {active.length} active
                                {ir.length > 0 ? ` · ${ir.length} IR` : ''}
                                {taxi.length > 0 ? ` · ${taxi.length} Taxi` : ''}
                            </Text>
                        </View>

                        <SectionHeader label="Starters & Bench · slot order" />
                        {renderRosterRows(active)}
                        {ir.length > 0 ? (
                            <>
                                <SectionHeader label="IR" />
                                {renderRosterRows(ir)}
                            </>
                        ) : null}
                        <SectionHeader label="Taxi Squad" />
                        {taxi.length > 0 ? renderRosterRows(taxi) : (
                            <View style={styles.taxiEmpty}>
                                <Text style={styles.taxiEmptyText}>No players on taxi squad</Text>
                            </View>
                        )}
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },

    header: {
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    // Header actions align with the centered roster column below instead of
    // pinning to the far edges of a wide canvas.
    headerInner: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        width: '100%',
        maxWidth: 680,
        alignSelf: 'center',
    },
    closeButton: { minWidth: 64, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    closeText: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.primaryDark },
    headerTitle: { flex: 1, fontSize: fontSize['2lg'], fontWeight: fontWeight.extrabold, textAlign: 'center' },

    list: { flex: 1 },
    listContent: { width: '100%', maxWidth: 680, alignSelf: 'center' },

    countRow: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    countText: { fontSize: fontSize.sm, color: colors.textMuted },
    separator: {
        height: 1,
        marginLeft: spacing.xl + 44 + spacing.lg,
        backgroundColor: colors.separator,
    },
    taxiEmpty: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
    },
    taxiEmptyText: {
        fontSize: fontSize.sm,
        color: colors.textPlaceholder,
        fontStyle: 'italic',
    },
})
