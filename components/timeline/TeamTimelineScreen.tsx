import { formatLeagueDateTime } from '@/lib/timezone'
import { useEffect, useState } from 'react'
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from 'react-native'
import { ScreenFrame } from '@/components/ui/ScreenFrame'
import { Button } from '@/components/ui/Button'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { borderWidth, colors, layout, spacing, textStyles } from '@/constants/tokens'
import { timelineMatches, timelineRelativeTime, type TimelineFilter } from '@/lib/timeline'
import { useTeamTimeline } from '@/lib/timeline/useTeamTimeline'

const filters: { value: TimelineFilter; label: string }[] = [
    { value: 'all', label: 'All' }, { value: 'claims', label: 'Claims' }, { value: 'trades', label: 'Trades' },
    { value: 'lineups', label: 'Lineups' }, { value: 'scores', label: 'Scores' },
]

export function TeamTimelineScreen({ leagueId, memberId, teamName, entityId, filter: initialFilter = 'all', enabled = true, showTitle = true, timezone }: {
    leagueId: string | null
    memberId: string | null
    teamName?: string
    entityId?: string
    filter?: TimelineFilter
    enabled?: boolean
    showTitle?: boolean
    timezone?: string
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
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, width: '100%', maxWidth: layout.formMaxWidth, alignSelf: 'center' }}
            refreshControl={<RefreshControl refreshing={timeline.loading} onRefresh={() => { void timeline.refresh() }} />}>
            <View style={{ gap: spacing.sm }}>
                {showTitle ? <Text accessibilityRole="header" style={textStyles.pageTitle}>Timeline</Text> : null}
                <Text style={textStyles.body}>{teamName ? `${teamName} activity` : 'Your team activity'}</Text>
            </View>
            <SegmentedControl options={filters} value={filter} onChange={setFilter} accessibilityLabel="Timeline filter" scrollable />
            {focusedEntity ? <Button variant="ghost" size="sm" title="Show all team activity" style={{ alignSelf: 'flex-start' }} onPress={() => setFocusedEntity(undefined)} /> : null}
            {timeline.error ? <View accessibilityRole="alert" style={{ gap: spacing.sm }}>
                <Text style={{ ...textStyles.body, color: colors.dangerDark }}>{timeline.error}</Text>
                <Button variant="outline" size="sm" title="Try again" style={{ alignSelf: 'flex-start' }} onPress={() => { void timeline.retry() }} />
            </View> : null}
            {timeline.loading && !timeline.events.length ? <ActivityIndicator accessibilityLabel="Loading timeline" color={colors.primary} /> : null}
            {!timeline.loading && !timeline.error && !events.length ? <Text style={textStyles.body}>
                {timeline.hasMore ? 'No matching activity on this page. Load older activity to continue.' : 'No activity here yet. Team results appear here when they happen.'}
            </Text> : null}
            <View>
                {events.map(event => <View key={event.id} style={{ borderLeftWidth: borderWidth.strong, borderColor: colors.borderLight, paddingLeft: spacing.lg, paddingBottom: spacing.xl, gap: spacing.sm }}>
                    <Text accessibilityLabel={formatLeagueDateTime(event.createdAt, timezone)} style={textStyles.meta}>{`${timelineRelativeTime(event.createdAt, now, timezone)} · ${formatLeagueDateTime(event.createdAt, timezone)}`}</Text>
                    <Text style={textStyles.rowTitle}>{event.summary}</Text>
                    {event.reason !== null ? <Text selectable style={{ ...textStyles.body, color: colors.textPrimary }}>{event.reason}</Text> : null}
                    {typeof event.detail.bid_amount === 'number' ? <Text style={textStyles.body}>Bid: ${event.detail.bid_amount}</Text> : null}
                </View>)}
            </View>
            {timeline.hasMore ? <Button variant="outline" size="sm" style={{ alignSelf: 'flex-start' }} disabled={timeline.loadingMore || timeline.loading}
                title={timeline.loadingMore ? 'Loading older activity…' : 'Load older activity'} onPress={() => { void timeline.loadMore() }} /> : null}
        </ScrollView>
    </ScreenFrame>
}
