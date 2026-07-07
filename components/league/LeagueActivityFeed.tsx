import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useCallback } from 'react'
import { FlashList, type ListRenderItem } from '@shopify/flash-list'
import { TransactionRow, TRANSACTION_LABELS, activityEventCategory } from '@/lib/transactions'
import { getPositionColor } from '@/constants/positions'
import { colors, fontSize, fontWeight, spacing, srOnly, TX_COLORS } from '@/constants/tokens'
import { playerHeadshotUrl, timeAgo } from '@/lib/format'
import { ItemSeparator } from '@/components/ItemSeparator'
import { EmptyState } from '@/components/EmptyState'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { useWebViewport } from '@/hooks/use-web-viewport'

function ActivityRow({ item, isMe, compact }: { item: TransactionRow; isMe: boolean; compact?: boolean }) {
    const color = TX_COLORS[item.transactionType] ?? colors.textMuted
    const label = TRANSACTION_LABELS[item.transactionType] ?? activityEventCategory(item.transactionType)
    const avatarSize = compact ? 32 : 40
    if (item.isSystem) {
        return (
            <View style={[styles.txRow, compact && styles.txRowCompact, isMe && styles.txRowMe]}>
                <Avatar
                    name={item.title ?? item.playerName}
                    color={color}
                    size={avatarSize}
                />
                <View style={styles.txInfo}>
                    <Text style={[styles.txPlayer, compact && styles.txPlayerCompact]} numberOfLines={1}>{item.title ?? item.playerName}</Text>
                    <Text style={styles.txTeam} numberOfLines={compact ? 1 : 2}>
                        {item.body ?? item.teamName}
                        {isMe ? <Text style={styles.meTag}> (you)</Text> : null}
                    </Text>
                </View>
                <View style={styles.txRight}>
                    <Badge label={label} color={color} variant="soft" />
                    <Text style={styles.txTime}>{timeAgo(item.occurredAt)}</Text>
                </View>
            </View>
        )
    }

    return (
        <View style={[styles.txRow, compact && styles.txRowCompact, isMe && styles.txRowMe]}>
            <Avatar
                name={item.playerName}
                color={colors.bgMuted}
                size={avatarSize}
                uri={playerHeadshotUrl(item.nbaId)}
            />
            <View style={styles.txInfo}>
                <View style={styles.txNameRow}>
                    <Text style={[styles.txPlayer, compact && styles.txPlayerCompact]} numberOfLines={1}>{item.playerName}</Text>
                    {item.eligiblePositions.map((pos) => <PosTag key={pos} position={pos} />)}
                </View>
                <Text style={styles.txTeam} numberOfLines={1}>
                    {item.teamName}
                    {isMe ? <Text style={styles.meTag}> (you)</Text> : null}
                </Text>
            </View>
            <View style={styles.txRight}>
                <Badge label={label} color={color} variant="soft" />
                <Text style={styles.txTime}>{timeAgo(item.occurredAt)}</Text>
            </View>
        </View>
    )
}

export function ActivityFeed({
    transactions,
    myMemberId,
    onLoadMore,
    hasMore,
    loading,
    loadingMore,
    loadMoreError,
}: {
    transactions: TransactionRow[]
    myMemberId?: string
    onLoadMore?: () => void
    hasMore?: boolean
    loading?: boolean
    loadingMore?: boolean
    loadMoreError?: string | null
}) {
    const { compactLandscape } = useWebViewport()

    const renderItem = useCallback<ListRenderItem<TransactionRow>>(({ item }) => (
        <ActivityRow item={item} isMe={item.memberId === myMemberId} compact={compactLandscape} />
    ), [compactLandscape, myMemberId])
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
            <Text style={{ fontSize: fontSize.sm, color: colors.dangerDark, fontWeight: fontWeight.semibold }}>
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
            <Text style={{ fontSize: fontSize.sm, color: colors.primaryDark, fontWeight: fontWeight.semibold }}>
                {loadingMore ? 'Loading...' : 'Load More'}
            </Text>
        </Pressable>
    ) : null
    const emptyState = loading
        ? {
              message: 'Loading league activity...',
              description: 'Fetching adds, drops, trades, and league updates.',
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
            <EmptyState message={emptyState.message} description={emptyState.description} fullScreen={false} />
        </View>
    )

    // Visually hidden section heading so the feed lands in the page outline
    // (League name is the screen's h1).
    const ActivityHeading = (
        <Text style={styles.activityHiddenHeading} role="heading" aria-level={2} accessibilityRole="header">
            Activity
        </Text>
    )

    return (
        <FlashList
            key={compactLandscape ? 'compact-activity' : 'activity'}
            data={transactions}
            keyExtractor={(t) => t.id}
            ItemSeparatorComponent={ItemSeparator}
            renderItem={renderItem}
            ListHeaderComponent={ActivityHeading}
            ListFooterComponent={ListFooter}
            ListEmptyComponent={ListEmpty}
            extraData={compactLandscape}
        />
    )
}

const styles = StyleSheet.create({
    txRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.lg,
    },
    txRowCompact: {
        minHeight: 52,
        paddingVertical: spacing.xs,
        gap: spacing.md,
    },
    txRowMe: { backgroundColor: colors.primaryLight },
    txInfo: { flex: 1, gap: spacing.xxs },
    txNameRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
    txPlayer: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    txPlayerCompact: { fontSize: fontSize.sm },
    txTeam: { fontSize: 12, color: colors.textMuted },
    txRight: { alignItems: 'flex-end', gap: spacing.xs },
    txTime: { fontSize: fontSize.xs, color: colors.textPlaceholder },
    meTag: { color: colors.textPlaceholder, fontWeight: fontWeight.regular, fontSize: fontSize.sm },
    activityFooterAction: {
        minHeight: 44,
        padding: spacing['2xl'],
        alignItems: 'center',
        justifyContent: 'center',
    },
    activityHiddenHeading: {
        ...srOnly,
    },
})
