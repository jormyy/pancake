import { formatLeagueDateTime } from '@/lib/timezone'
import { useLeagueTimezone } from '@/hooks/use-league-timezone'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { TradePickLabel } from '@/components/trades/TradePickLabel'
import { usePullToRefresh } from '@/hooks/use-pull-to-refresh'
import { useScreenStatusScroll } from '@/components/ui/ScreenStatusOverlay'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useCallback } from 'react'
import { FlashList, type ListRenderItem } from '@shopify/flash-list'
import { TransactionRow, TRANSACTION_LABELS, activityEventCategory } from '@/lib/transactions'
import { alpha, colors, controlSize, fontSize, fontWeight, layout, spacing, srOnly, table, textStyles, TX_COLORS } from '@/constants/tokens'
import { ItemSeparator } from '@/components/ItemSeparator'
import { EmptyState } from '@/components/EmptyState'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'

import { usePageMetrics } from '@/components/ui'

/** One league transaction. */
function ActivityRow({ item, isMe, myMemberId, padX = spacing.lg }: { item: TransactionRow; isMe: boolean; myMemberId?: string; padX?: number }) {
    const timezone = useLeagueTimezone()
    const color = TX_COLORS[item.transactionType] ?? colors.textMuted
    const label = item.transactionType === 'commissioner_announcement' ? 'Commissioner' : TRANSACTION_LABELS[item.transactionType] ?? activityEventCategory(item.transactionType)
    const avatarSize = controlSize.avatar.md
    if (item.isSystem) {
        return (
            <View style={[styles.txRow, { paddingHorizontal: padX }, isMe && styles.txRowMe]}>
                <Avatar
                    name={item.title ?? item.playerName}
                    color={alpha(color, 0.22)}
                    textColor={colors.textPrimary}
                    size={avatarSize}
                />
                <View style={styles.txInfo}>
                    <Text style={styles.txPlayer}>{item.title ?? item.playerName}</Text>
                    <Text style={styles.txTeam} numberOfLines={item.transactionType === 'commissioner_announcement' ? undefined : 2}>
                        {item.body ?? item.teamName}
                        {isMe ? <Text style={styles.meTag}> (you)</Text> : null}
                    </Text>
                    {item.tradePicks?.map(pick => <TradePickLabel key={pick.pickId} pick={pick} context={{
                        viewerMemberId: myMemberId ?? '',
                        memberNames: { [pick.fromMemberId ?? '']: pick.fromTeamName, [pick.toMemberId ?? '']: pick.toTeamName },
                    }} />)}
                </View>
                <View style={styles.txRight}>
                    <Badge label={label} color={color} variant="soft" />
                    <Text style={styles.txTime}>{formatLeagueDateTime(item.occurredAt, timezone)}</Text>
                </View>
            </View>
        )
    }

    return (
        <View style={[styles.txRow, { paddingHorizontal: padX }, isMe && styles.txRowMe]}>
            <PlayerRowContent name={item.playerName} nbaId={item.nbaId} team={item.nbaTeam} positions={item.eligiblePositions} playerId={item.playerId} yearsExp={item.yearsExp} careerGames={item.careerGames} injuryStatus={item.injuryStatus}
                stats={`${item.teamName}${isMe ? ' (you)' : ''}`} />
            <View style={styles.txRight}>
                <Badge label={label} color={color} variant="soft" />
                <Text style={styles.txTime}>{formatLeagueDateTime(item.occurredAt, timezone)}</Text>
            </View>
        </View>
    )
}

export function ActivityFeed({
    transactions,
    myMemberId,
    onLoadMore,
    onRefresh,
    refreshing,
    hasMore,
    loading,
    loadingMore,
    loadMoreError,
}: {
    transactions: TransactionRow[]
    myMemberId?: string
    onLoadMore?: () => void
    onRefresh?: () => void | Promise<void>
    refreshing?: boolean
    hasMore?: boolean
    loading?: boolean
    loadingMore?: boolean
    loadMoreError?: string | null
}) {
    const statusScroll = useScreenStatusScroll()
    const pullRefresh = usePullToRefresh(onRefresh, Boolean(refreshing), statusScroll.onScroll)
    const { padX } = usePageMetrics()

    const renderItem = useCallback<ListRenderItem<TransactionRow>>(({ item }) => (
        <ActivityRow item={item} isMe={item.memberId === myMemberId} myMemberId={myMemberId} padX={padX} />
    ), [myMemberId, padX])
    const footerRetryMessage = 'League activity could not load more. Select to retry.'

    const ListFooter = loadMoreError ? (
        <Pressable
            onPress={onLoadMore}
            role="button"
            aria-label={footerRetryMessage}
            aria-live="polite"
            accessibilityRole="button"
            accessibilityLabel={footerRetryMessage}
            accessibilityLiveRegion="polite"
            style={styles.activityFooterAction}
        >
            <Text style={[styles.footerText, styles.footerTextDanger]}>
                {footerRetryMessage}
            </Text>
        </Pressable>
    ) : hasMore || loadingMore ? (
        <Pressable
            onPress={onLoadMore}
            disabled={loadingMore}
            role="button"
            aria-label={loadingMore ? 'Loading more league activity' : 'Load more league activity'}
            aria-disabled={loadingMore}
            accessibilityRole="button"
            accessibilityLabel={loadingMore ? 'Loading more league activity' : 'Load more league activity'}
            accessibilityState={{ disabled: loadingMore }}
            style={styles.activityFooterAction}
        >
            <Text style={styles.footerText}>
                Load More
            </Text>
        </Pressable>
    ) : null
    const emptyState = loading
        ? {
              message: '',
              description: '',
              accessibilityLabel: 'Loading league activity. Fetching adds, drops, trades, and league updates.',
          }
        : {
              message: 'No transactions yet.',
              description: 'Adds, drops, and trades are listed here.',
              accessibilityLabel: 'No league activity yet. Adds, drops, and trades are listed here.',
          }
    const ListEmpty = (
        <View
            role="status"
            aria-live="polite"
            aria-busy={loading ? true : undefined}
            aria-label={emptyState.accessibilityLabel}
            accessibilityLabel={emptyState.accessibilityLabel}
            accessibilityLiveRegion="polite"
            accessibilityState={{ busy: loading }}
        >
            <View style={{ minHeight: 320 }}>{!loading ? <EmptyState message={emptyState.message} description={emptyState.description} fullScreen={false} /> : null}</View>
        </View>
    )

    // Visually hidden section heading so the feed lands in the page outline
    // under the League h1.
    const ActivityHeading = (
        <Text style={styles.activityHiddenHeading} role="heading" aria-level={2} accessibilityRole="header">
            Activity
        </Text>
    )

    // A readable column on wide screens instead of rows stretched edge to edge.
    return (
        <View style={styles.column}>
            <FlashList
                {...pullRefresh}
                scrollEventThrottle={16}
                contentContainerStyle={statusScroll.contentStyle()}
                data={transactions}
                onRefresh={onRefresh}
                refreshing={Boolean(refreshing)}
                keyExtractor={(t) => t.id}
                ItemSeparatorComponent={ItemSeparator}
                renderItem={renderItem}
                ListHeaderComponent={ActivityHeading}
                ListFooterComponent={ListFooter}
                ListEmptyComponent={ListEmpty}
                extraData={padX}
            />
        </View>
    )
}

const styles = StyleSheet.create({
    column: { flex: 1, width: '100%', maxWidth: layout.formMaxWidth + 2 * layout.pagePadX.regular, alignSelf: 'center' },
    txRow: {
        minHeight: table.rowHeight,
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.sm,
        gap: spacing.md,
    },
    txRowMe: { backgroundColor: colors.primaryLight },
    txInfo: { flex: 1, minWidth: 0, gap: spacing.xxs },
    txNameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' },
    txPlayer: { ...textStyles.rowTitle, flexShrink: 1 },
    txTeam: { ...textStyles.meta },
    txRight: { alignItems: 'flex-end', gap: spacing.xxs },
    txTime: { fontSize: fontSize.xs, color: colors.textMuted },
    meTag: { color: colors.textMuted, fontWeight: fontWeight.regular },
    activityFooterAction: {
        minHeight: 44,
        padding: spacing['2xl'],
        alignItems: 'center',
        justifyContent: 'center',
    },
    footerText: { fontSize: fontSize.sm, color: colors.primaryDark, fontWeight: fontWeight.semibold },
    footerTextDanger: { color: colors.dangerDark },
    activityHiddenHeading: {
        ...srOnly,
    },
})
