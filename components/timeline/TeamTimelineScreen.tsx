import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { ScreenFrame } from '@/components/ui/ScreenFrame'
import { colors, spacing, textStyles } from '@/constants/tokens'
import { timelineMatches, timelineRelativeTime, type TimelineFilter } from '@/lib/timeline'
import { useTeamTimeline } from '@/lib/timeline/useTeamTimeline'

const filters: { value: TimelineFilter; label: string }[] = [
    { value: 'all', label: 'All' }, { value: 'claims', label: 'Claims' }, { value: 'trades', label: 'Trades' },
    { value: 'lineups', label: 'Lineups' }, { value: 'scores', label: 'Scores' },
]

export function TeamTimelineScreen({ leagueId, memberId, teamName, entityId, filter: initialFilter = 'all', enabled = true, showTitle = true }: {
    leagueId: string | null
    memberId: string | null
    teamName?: string
    entityId?: string
    filter?: TimelineFilter
    enabled?: boolean
    showTitle?: boolean
}) {
    const timeline = useTeamTimeline({ leagueId, memberId, enabled })
    const [filter, setFilter] = useState(initialFilter)
    const [focusedEntity, setFocusedEntity] = useState(entityId)
    const [now, setNow] = useState(Date.now)
    useEffect(() => { setFilter(initialFilter); setFocusedEntity(entityId) }, [entityId, initialFilter, leagueId, memberId])
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000)
        return () => clearInterval(timer)
    }, [])
    const focusedThread = timeline.events.find(event => event.entityId === focusedEntity || event.threadId === focusedEntity)?.threadId
    const events = timeline.events.filter(event => timelineMatches(event, filter)
        && (!focusedEntity || event.entityId === focusedEntity || Boolean(focusedThread && event.threadId === focusedThread)))
    return <ScreenFrame style={{ flex: 1, backgroundColor: colors.bgScreen }}>
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, width: '100%', maxWidth: 760, alignSelf: 'center' }}
            refreshControl={<RefreshControl refreshing={timeline.loading} onRefresh={() => { void timeline.refresh() }} />}>
            <View style={{ gap: spacing.sm }}>
                {showTitle ? <Text accessibilityRole="header" style={textStyles.pageTitle}>Timeline</Text> : null}
                <Text style={textStyles.body}>{teamName ? `${teamName} activity` : 'Your team activity'}</Text>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                {filters.map(item => <Pressable key={item.value} accessibilityRole="button" accessibilityState={{ selected: filter === item.value }}
                    onPress={() => setFilter(item.value)} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md,
                        borderBottomWidth: filter === item.value ? 3 : 1, borderColor: filter === item.value ? colors.primary : colors.borderLight }}>
                    <Text style={{ ...textStyles.body, color: filter === item.value ? colors.primaryDark : colors.textSecondary }}>{item.label}</Text>
                </Pressable>)}
            </View>
            {focusedEntity ? <Pressable accessibilityRole="button" onPress={() => setFocusedEntity(undefined)} style={{ minHeight: 44, justifyContent: 'center' }}>
                <Text style={{ ...textStyles.body, color: colors.primaryDark }}>Show all team activity</Text>
            </Pressable> : null}
            {timeline.error ? <View accessibilityRole="alert" style={{ gap: spacing.sm }}>
                <Text style={{ ...textStyles.body, color: colors.dangerDark }}>{timeline.error}</Text>
                <Pressable accessibilityRole="button" onPress={() => { void timeline.retry() }} style={{ minHeight: 44, justifyContent: 'center' }}>
                    <Text style={{ ...textStyles.body, color: colors.primaryDark }}>Try again</Text>
                </Pressable>
            </View> : null}
            {timeline.loading && !timeline.events.length ? <ActivityIndicator accessibilityLabel="Loading timeline" color={colors.primary} /> : null}
            {!timeline.loading && !timeline.error && !events.length ? <Text style={textStyles.body}>
                {timeline.hasMore ? 'No matching activity on this page. Load older activity to continue.' : 'No activity here yet. Team results appear here when they happen.'}
            </Text> : null}
            <View>
                {events.map(event => <View key={event.id} style={{ borderLeftWidth: 2, borderColor: colors.borderLight, paddingLeft: spacing.lg, paddingBottom: spacing.xl, gap: spacing.sm }}>
                    <Text accessibilityLabel={new Date(event.createdAt).toLocaleString()} style={textStyles.meta}>{timelineRelativeTime(event.createdAt, now)}</Text>
                    <Text style={textStyles.rowTitle}>{event.summary}</Text>
                    {event.reason !== null ? <Text selectable style={{ ...textStyles.body, color: colors.textPrimary }}>{event.reason}</Text> : null}
                    {typeof event.detail.bid_amount === 'number' ? <Text style={textStyles.body}>Bid: ${event.detail.bid_amount}</Text> : null}
                </View>)}
            </View>
            {timeline.hasMore ? <Pressable accessibilityRole="button" disabled={timeline.loadingMore || timeline.loading}
                onPress={() => { void timeline.loadMore() }} style={{ minHeight: 44, justifyContent: 'center' }}>
                <Text style={{ ...textStyles.body, color: colors.primaryDark }}>{timeline.loadingMore ? 'Loading older activity…' : 'Load older activity'}</Text>
            </Pressable> : null}
        </ScrollView>
    </ScreenFrame>
}
