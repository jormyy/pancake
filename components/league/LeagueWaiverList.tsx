import { View, Text, StyleSheet } from 'react-native'
import { useCallback } from 'react'
import { FlashList, type ListRenderItem } from '@shopify/flash-list'
import { WaiverPriorityRow } from '@/lib/waivers'
import { colors, fontSize, fontWeight, spacing } from '@/constants/tokens'
import { ItemSeparator } from '@/components/ItemSeparator'
import { EmptyState } from '@/components/EmptyState'
import { tableStyles } from '@/components/league/leagueTableStyles'

// Styles must be declared before the const JSX header that references them.
const styles = StyleSheet.create({
    waiverRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: 11,
    },
    waiverHeader: { borderBottomWidth: 1, borderBottomColor: colors.borderLight, paddingVertical: spacing.md },
    waiverRank: { width: 32, fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textSecondary },
    waiverTeam: { flex: 1, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    waiverName: { width: 110, textAlign: 'right', fontSize: fontSize.sm, color: colors.textMuted },
})

function WaiverRow({ item, isMe, rank }: { item: WaiverPriorityRow; isMe: boolean; rank: number }) {
    return (
        <View style={[styles.waiverRow, isMe && tableStyles.rowMe]}>
            <Text style={[styles.waiverRank, isMe && tableStyles.textMe]}>{rank}</Text>
            <Text style={[styles.waiverTeam, isMe && tableStyles.textMe]} numberOfLines={1}>
                {item.teamName}
            </Text>
            <Text style={[styles.waiverName, isMe && tableStyles.textMe]} numberOfLines={1}>
                {item.displayName}
            </Text>
        </View>
    )
}

const WaiverListHeader = (
    <View style={[styles.waiverRow, styles.waiverHeader]}>
        <Text style={[styles.waiverRank, tableStyles.headerText]}>#</Text>
        <Text style={[styles.waiverTeam, tableStyles.headerText]}>Team</Text>
        <Text style={[styles.waiverName, tableStyles.headerText]}>Manager</Text>
    </View>
)

export function WaiverPriorityList({ rows, myMemberId }: { rows: WaiverPriorityRow[]; myMemberId?: string }) {
    const renderItem = useCallback<ListRenderItem<WaiverPriorityRow>>(({ item, index }) => (
        <WaiverRow item={item} isMe={item.memberId === myMemberId} rank={index + 1} />
    ), [myMemberId])

    return (
        <FlashList
            data={rows}
            keyExtractor={(r) => r.memberId}
            ListHeaderComponent={rows.length ? WaiverListHeader : undefined}
            ItemSeparatorComponent={ItemSeparator}
            renderItem={renderItem}
            ListEmptyComponent={<EmptyState message="No waiver priorities yet." description="Priority order is listed here once the season starts." fullScreen={false} />}
        />
    )
}
