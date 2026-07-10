import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { Avatar } from '@/components/Avatar'
import { MotionPressable, MotionView } from '@/components/Motion'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
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
    historyListHeight,
}: Props) {
    return (
        <View style={[styles.column, compact && styles.columnCompact, desktop && styles.columnDesktop]}>
            <View style={styles.tabRow}>
                {(['budgets', 'history'] as const).map((nextTab) => (
                    <MotionPressable
                        key={nextTab}
                        style={[styles.tabChip, tab === nextTab && styles.tabChipActive]}
                        onPress={() => onTabChange(nextTab)}
                        pressedScale={0.94}
                    >
                        <Text style={[styles.tabChipText, tab === nextTab && styles.tabChipTextActive]}>
                            {nextTab === 'budgets' ? 'Budgets' : `History (${closedNominations.length})`}
                        </Text>
                    </MotionPressable>
                ))}
            </View>

            {tab === 'budgets' ? (
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
            ) : closedNominations.length === 0 ? (
                <View style={styles.empty}><Text style={styles.emptyText}>No players sold yet.</Text></View>
            ) : (
                <MotionView style={[styles.card, compact && styles.cardCompact]} preset="rise" delay={80}>
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
                                            size={34}
                                        />
                                        <View style={styles.flex1}>
                                            <Text style={styles.historyPlayer}>{item.player?.displayName ?? 'Unknown'}</Text>
                                            <Text style={styles.historyMeta}>
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
            )}
        </View>
    )
})

const styles = StyleSheet.create({
    column: { gap: spacing.lg },
    columnCompact: { gap: spacing.sm },
    columnDesktop: { flex: 2, minWidth: 0 },
    tabRow: { flexDirection: 'row', gap: spacing.md },
    tabChip: { flex: 1, minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14, borderRadius: radii.md, borderCurve: 'continuous', backgroundColor: colors.bgMuted },
    tabChipActive: { backgroundColor: colors.primary },
    tabChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    tabChipTextActive: { color: colors.textWhite },
    card: { backgroundColor: colors.bgScreen, borderRadius: radii.md, borderCurve: 'continuous', borderWidth: 1, borderColor: colors.borderLight, padding: spacing.xl, gap: spacing.md },
    cardCompact: { padding: spacing.md, gap: spacing.sm },
    budgetRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
    divider: { borderTopWidth: 1, borderTopColor: colors.separator },
    budgetTeam: { flex: 1, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    budgetAmount: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    budgetWon: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textMuted, marginRight: spacing.lg },
    meAccent: { color: colors.primaryDark },
    historyRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: spacing.md },
    flex1: { flex: 1 },
    historyPlayer: { fontSize: fontSize.md, fontWeight: fontWeight.semibold },
    historyMeta: { fontSize: fontSize['2sm'], color: colors.textMuted, marginTop: 1 },
    historyPrice: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    historyNoBid: { fontSize: fontSize['2sm'], fontWeight: fontWeight.bold, color: colors.textPlaceholder, backgroundColor: colors.bgMuted, paddingHorizontal: spacing.md, paddingVertical: 3, borderRadius: radii.sm, borderCurve: 'continuous' },
    empty: { alignItems: 'center', paddingVertical: spacing['3xl'] },
    emptyText: { fontSize: fontSize.sm, color: colors.textPlaceholder },
})
