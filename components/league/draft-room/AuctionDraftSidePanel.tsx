import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { Avatar } from '@/components/Avatar'
import { MotionView } from '@/components/Motion'
import { SegmentedControl } from '@/components/ui'
import { colors, fontSize, fontWeight, radii, spacing, table, textStyles } from '@/constants/tokens'
import { draftAgeLabel, draftEventTime, draftPlayerMeta } from '@/lib/draft-display'
import { playerHeadshotUrl } from '@/lib/format'
import type { DraftBudget, DraftNomination } from '@/lib/draft'
import type { DraftTab } from '@/hooks/useAuctionDraftRoomController'

type Props = {
    tab: DraftTab
    onTabChange: (tab: DraftTab) => void
    budgets: DraftBudget[]
    closedNominations: DraftNomination[]
    budgetByMember: Map<string, DraftBudget>
    wonCountByMember: Map<string, number>
    myMemberId?: string
    compact: boolean
    desktop: boolean
    /** Show budgets and history together instead of behind tabs. */
    stacked?: boolean
    historyListHeight: number
}

export const AuctionDraftSidePanel = memo(function AuctionDraftSidePanel({
    tab,
    onTabChange,
    budgets,
    closedNominations,
    budgetByMember,
    wonCountByMember,
    myMemberId,
    compact,
    desktop,
    stacked = false,
    historyListHeight,
}: Props) {
    const budgetsCard = budgets.length === 0 ? (
        <View style={styles.empty}><Text style={styles.emptyText}>Budgets appear when the draft starts.</Text></View>
    ) : (
        <MotionView style={[styles.card, compact && styles.cardCompact]} preset="rise" delay={80}>
            {[...budgets]
                .sort((left, right) => right.remaining - left.remaining)
                .map((budget, index) => (
                    <View key={budget.memberId} style={[styles.budgetRow, index > 0 && styles.divider]}>
                        <Text style={[styles.budgetTeam, budget.memberId === myMemberId && styles.meAccent]} numberOfLines={1}>
                            {budget.teamName}{budget.memberId === myMemberId ? ' (you)' : ''}
                        </Text>
                        <Text style={styles.budgetWon}>{wonCountByMember.get(budget.memberId) ?? 0} won</Text>
                        <Text style={[styles.budgetAmount, budget.memberId === myMemberId && styles.meAccent]}>
                            ${budget.remaining}
                        </Text>
                    </View>
                ))}
        </MotionView>
    )
    const historyCard = closedNominations.length === 0 ? (
        <View style={styles.empty}><Text style={styles.emptyText}>No players sold yet.</Text></View>
    ) : (
        <MotionView style={[styles.card, styles.historyCard, compact && styles.cardCompact]} preset="rise" delay={80}>
            <View style={{ height: historyListHeight }}>
                <FlashList
                    data={closedNominations}
                    keyExtractor={(nomination) => nomination.id}
                    nestedScrollEnabled
                    renderItem={({ item, index }) => {
                        const winnerTeam = item.winningMemberId
                            ? budgetByMember.get(item.winningMemberId)?.teamName
                            : undefined
                        return (
                            <View style={[styles.historyRow, index > 0 && styles.divider]}>
                                <Avatar
                                    name={item.player?.displayName ?? 'Player'}
                                    color={colors.bgMuted}
                                    uri={playerHeadshotUrl(item.player?.nbaId)}
                                    size={32}
                                />
                                <View style={styles.flex1}>
                                    <Text style={styles.historyPlayer} numberOfLines={1}>{item.player?.displayName ?? 'Unknown'}</Text>
                                    <Text style={styles.historyMeta} numberOfLines={1}>
                                        {draftPlayerMeta([
                                            `#${item.nominationOrder}`,
                                            draftEventTime(item.nominatedAt),
                                            item.status === 'sold' ? (winnerTeam ?? '—') : 'No bid',
                                            draftAgeLabel(item.player?.age),
                                        ])}
                                    </Text>
                                </View>
                                {item.status === 'sold' ? <Text style={styles.historyPrice}>${item.finalPrice}</Text> : null}
                                {item.status === 'no_bid' ? <Text style={styles.historyNoBid}>FA</Text> : null}
                            </View>
                        )
                    }}
                />
            </View>
        </MotionView>
    )

    if (stacked) {
        return (
            <View style={[styles.column, desktop && styles.columnDesktop]}>
                <Text style={textStyles.sectionLabel} role="heading" aria-level={2}>Budgets</Text>
                {budgetsCard}
                <Text style={[textStyles.sectionLabel, styles.stackedHeading]} role="heading" aria-level={2}>
                    History ({closedNominations.length})
                </Text>
                {historyCard}
            </View>
        )
    }

    return (
        <View style={[styles.column, compact && styles.columnCompact, desktop && styles.columnDesktop]}>
            <SegmentedControl<DraftTab>
                variant="tabs"
                value={tab}
                onChange={onTabChange}
                options={[
                    { label: 'Budgets', value: 'budgets' },
                    { label: `History (${closedNominations.length})`, value: 'history' },
                ]}
                accessibilityLabel="Draft board"
                idBase="auction-side-panel"
            />

            {tab === 'budgets' ? budgetsCard : historyCard}
        </View>
    )
})

const styles = StyleSheet.create({
    column: { gap: spacing.md },
    columnCompact: { gap: spacing.sm },
    columnDesktop: { flex: 2, minWidth: 0 },
    stackedHeading: { marginTop: spacing.md },
    card: { backgroundColor: colors.bgCard, borderRadius: radii.lg, borderCurve: 'continuous', borderWidth: 1, borderColor: colors.borderLight, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
    cardCompact: { paddingHorizontal: spacing.md },
    historyCard: { paddingVertical: 0 },
    budgetRow: { flexDirection: 'row', alignItems: 'center', minHeight: table.rowHeightCompact, gap: spacing.md },
    divider: { borderTopWidth: 1, borderTopColor: colors.separator },
    budgetTeam: { ...textStyles.rowTitle, flex: 1 },
    budgetAmount: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.textPrimary, fontVariant: ['tabular-nums'] as const },
    budgetWon: { ...textStyles.meta, fontWeight: fontWeight.semibold },
    meAccent: { color: colors.primaryDark },
    historyRow: { flexDirection: 'row', alignItems: 'center', minHeight: table.rowHeight, gap: spacing.md },
    flex1: { flex: 1, minWidth: 0 },
    historyPlayer: { ...textStyles.rowTitle },
    historyMeta: { ...textStyles.meta },
    historyPrice: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: colors.textPrimary, fontVariant: ['tabular-nums'] as const },
    historyNoBid: { fontSize: fontSize['2sm'], fontWeight: fontWeight.bold, color: colors.textPlaceholder, backgroundColor: colors.bgMuted, paddingHorizontal: spacing.md, paddingVertical: spacing.xxs, borderRadius: radii.sm, borderCurve: 'continuous' },
    empty: { alignItems: 'center', paddingVertical: spacing['3xl'] },
    emptyText: { ...textStyles.meta, color: colors.textPlaceholder },
})
