import { CompletedTradeActivityCard } from '@/components/league/CompletedTradeActivityCard'
import { formatLeagueDateTime } from '@/lib/timezone'
import { useLeagueTimezone } from '@/hooks/use-league-timezone'
import { TradePlayerLink } from '@/components/trades/TradePlayerLink'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { TradePickLabel } from '@/components/trades/TradePickLabel'
import { orderTradeAssets } from '@/lib/trade-assets'
import { usePullToRefresh } from '@/hooks/use-pull-to-refresh'
import { useScreenStatusScroll } from '@/components/ui/ScreenStatusOverlay'
import { SectionBand } from '@/components/ui/SectionBand'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useCallback, useMemo } from 'react'
import { FlashList, type ListRenderItem } from '@shopify/flash-list'
import { TransactionRow, TRANSACTION_LABELS, activityEventCategory, organizeActivity } from '@/lib/transactions'
import { alpha, colors, controlSize, fontWeight, layout, radii, spacing, table, textStyles, TX_COLORS, typeScale } from '@/constants/tokens'
import { ItemSeparator } from '@/components/ItemSeparator'
import { EmptyState } from '@/components/EmptyState'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'

import { usePageMetrics } from '@/components/ui'

function ActivityRow({ item, isMe, myMemberId, padX = spacing.lg }: { item: TransactionRow; isMe: boolean; myMemberId?: string; padX?: number }) {
    const timezone = useLeagueTimezone()
    const color = TX_COLORS[item.transactionType] ?? colors.textMuted
    const baseLabel = item.transactionType === 'commissioner_announcement' ? 'Commissioner' : TRANSACTION_LABELS[item.transactionType] ?? activityEventCategory(item.transactionType)
    const label = item.bidAmount != null ? `${baseLabel} $${item.bidAmount}` : baseLabel
    const avatarSize = controlSize.avatar.md
    if (item.transactionType === 'trade_completed') {
        return <CompletedTradeActivityCard item={item} myMemberId={myMemberId} padX={padX} />
    }
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
                    {orderTradeAssets(item.tradePlayers ?? []).map(player => <Text key={player.playerId} style={styles.txTeam} numberOfLines={1}>{player.playerName} · {player.fromTeamName} → {player.toTeamName}</Text>)}
                    {orderTradeAssets(item.tradePicks ?? []).map(pick => <TradePickLabel key={pick.pickId} pick={pick} context={{
                        viewerMemberId: myMemberId ?? '',
                        memberNames: { [pick.fromMemberId ?? '']: pick.fromTeamName, [pick.toMemberId ?? '']: pick.toTeamName },
                    }} />)}
                </View>
                <View style={styles.txRight}>
                    <Badge label={label} color={color} variant="soft" />
                    <Text style={styles.txTime} numberOfLines={1}>{formatLeagueDateTime(item.occurredAt, timezone)}</Text>
                </View>
            </View>
        )
    }

    const playerProps = { name: item.playerName, nbaId: item.nbaId, team: item.nbaTeam, positions: item.eligiblePositions,
        yearsExp: item.yearsExp, careerGames: item.careerGames, injuryStatus: item.injuryStatus,
        stats: `${item.teamName}${isMe ? ' (you)' : ''}` }
    return (
        <View style={[styles.txRow, { paddingHorizontal: padX }, isMe && styles.txRowMe]}>
            {(item.transactionType === 'trade_in' || item.transactionType === 'trade_out') && item.playerId
                ? <TradePlayerLink {...playerProps} playerId={item.playerId} />
                : <PlayerRowContent {...playerProps} playerId={item.playerId} />}
            <View style={styles.txRight}>
                <Badge label={label} color={color} variant="soft" />
                <Text style={styles.txTime} numberOfLines={1}>{formatLeagueDateTime(item.occurredAt, timezone)}</Text>
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
    const organized = useMemo(() => organizeActivity(transactions), [transactions])

    const renderItem = useCallback<ListRenderItem<TransactionRow>>(({ item }) => (
        <ActivityRow item={item} isMe={item.memberId === myMemberId} myMemberId={myMemberId} padX={spacing.lg} />
    ), [myMemberId])
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

    return (
        <View style={[styles.column, { paddingHorizontal: padX }]}>
            <View style={styles.card}>
                <SectionBand label="Activity" />
                <FlashList
                    {...pullRefresh}
                    style={styles.list}
                    scrollEventThrottle={16}
                    contentContainerStyle={statusScroll.contentStyle()}
                    data={organized}
                    onRefresh={onRefresh}
                    refreshing={Boolean(refreshing)}
                    keyExtractor={(t) => t.id}
                    ItemSeparatorComponent={ItemSeparator}
                    renderItem={renderItem}
                    ListFooterComponent={ListFooter}
                    ListEmptyComponent={ListEmpty}
                    extraData={padX}
                />
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    column: { flex: 1, width: '100%', maxWidth: layout.formMaxWidth + 2 * layout.pagePadX.regular, alignSelf: 'center', paddingTop: spacing.md, paddingBottom: spacing.md },
    card: { flex: 1, minHeight: 0, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.borderLight, borderRadius: radii.xl, overflow: 'hidden' },
    list: { flex: 1, minHeight: 0 },
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
    txRight: { alignItems: 'flex-end', gap: spacing.xxs, flexShrink: 0 },
    txTime: { ...typeScale.caption, color: colors.textMuted },
    meTag: { color: colors.textMuted, fontWeight: fontWeight.regular },
    activityFooterAction: {
        minHeight: controlSize.minTouch,
        padding: spacing['3xl'],
        alignItems: 'center',
        justifyContent: 'center',
    },
    footerText: { ...typeScale.small, color: colors.primaryDark, fontWeight: fontWeight.semibold },
    footerTextDanger: { color: colors.dangerDark },
})
