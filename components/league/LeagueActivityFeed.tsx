import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useCallback } from 'react'
import { FlashList, type ListRenderItem } from '@shopify/flash-list'
import { TransactionRow, TRANSACTION_LABELS, activityEventCategory } from '@/lib/transactions'
import { alpha, colors, fontSize, fontWeight, layout, spacing, srOnly, table, textStyles, TX_COLORS } from '@/constants/tokens'
import { playerHeadshotUrl, timeAgo } from '@/lib/format'
import { ItemSeparator } from '@/components/ItemSeparator'
import { EmptyState } from '@/components/EmptyState'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { usePageMetrics } from '@/components/ui'

/** One league transaction. */
function ActivityRow({ item, isMe, padX = spacing.lg }: { item: TransactionRow; isMe: boolean; padX?: number }) {
    const color = TX_COLORS[item.transactionType] ?? colors.textMuted
    const label = TRANSACTION_LABELS[item.transactionType] ?? activityEventCategory(item.transactionType)
    const avatarSize = 32
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
                    <Text style={styles.txPlayer} numberOfLines={1}>{item.title ?? item.playerName}</Text>
                    <Text style={styles.txTeam} numberOfLines={2}>
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
        <View style={[styles.txRow, { paddingHorizontal: padX }, isMe && styles.txRowMe]}>
            <Avatar
                name={item.playerName}
                color={colors.bgMuted}
                size={avatarSize}
                uri={playerHeadshotUrl(item.nbaId)}
            />
            <View style={styles.txInfo}>
                <View style={styles.txNameRow}>
                    <Text style={styles.txPlayer} numberOfLines={1}>{item.playerName}</Text>
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
    const { padX } = usePageMetrics()

    const renderItem = useCallback<ListRenderItem<TransactionRow>>(({ item }) => (
        <ActivityRow item={item} isMe={item.memberId === myMemberId} padX={padX} />
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
                data={transactions}
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
