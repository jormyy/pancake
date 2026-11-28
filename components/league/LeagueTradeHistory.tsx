import { useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { EmptyState } from '@/components/EmptyState'
import { Card } from '@/components/ui/Card'
import { ListHeader } from '@/components/ui/ListHeader'
import { colors, spacing, textStyles } from '@/constants/tokens'
import { formatLeagueDate } from '@/lib/timezone'
import type { CompletedTradeHistory, ManagerTradeCount } from '@/lib/league-history'

export function LeagueTradeHistory({ trades, tradeCounts }: {
    trades: CompletedTradeHistory[]
    tradeCounts: ManagerTradeCount[]
}) {
    const orderedCounts = useMemo(() => [...tradeCounts].sort((a, b) => b.count - a.count || a.teamName.localeCompare(b.teamName, undefined, { numeric: true }) || a.memberId.localeCompare(b.memberId)), [tradeCounts])
    const orderedTrades = useMemo(() => [...trades].sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt) || b.id.localeCompare(a.id)), [trades])

    return (
        <>
            <View style={styles.copy}>
                <Text role="heading" accessibilityRole="header" style={textStyles.pageTitle}>Trade history</Text>
                <Text style={textStyles.meta}>Completed trades across every season</Text>
            </View>
            <Text role="heading" accessibilityRole="header" style={textStyles.rowTitle}>Trades by manager</Text>
            <Card padding="none" elevated="none" style={styles.table}>
                <ListHeader style={styles.row}>
                    <Text style={[textStyles.tableHeader, styles.team]}>Manager</Text>
                    <Text style={[textStyles.tableHeader, styles.count]} numberOfLines={1}>Trades</Text>
                </ListHeader>
                <View role="list" aria-label="Trades by manager">
                    {orderedCounts.map(entry => (
                        <View key={entry.memberId} role="listitem" style={styles.managerRow}
                            accessibilityLabel={`${entry.teamName}, ${entry.count} ${entry.count === 1 ? 'trade' : 'trades'}`}>
                            <Text style={[textStyles.rowTitle, styles.team]} numberOfLines={1}>{entry.teamName}</Text>
                            <Text style={[textStyles.tableCell, styles.count]} numberOfLines={1}>{entry.count}</Text>
                        </View>
                    ))}
                </View>
            </Card>
            {orderedTrades.length ? (
                <View role="list" aria-label="Completed trades" style={styles.trades}>
                    {orderedTrades.map(trade => {
                        const label = `Trade completed ${formatLeagueDate(trade.completedAt)}: ${trade.participants.map(participant => participant.teamName).join(', ')}`
                        return (
                            <View key={trade.id} role="listitem" aria-label={label} accessibilityLabel={label}>
                                <Card elevated="none" style={styles.trade}>
                                    <View style={styles.tradeHeader}>
                                        <Text style={textStyles.sectionLabel}>Trade completed</Text>
                                        <Text style={textStyles.meta}>{formatLeagueDate(trade.completedAt)}</Text>
                                    </View>
                                    <View style={styles.participants}>
                                        {trade.participants.map(participant => (
                                            <View key={participant.memberId} style={styles.participant}>
                                                <Text style={textStyles.rowTitle} numberOfLines={1}>{participant.teamName}</Text>
                                                <Text style={textStyles.meta}>{`Received ${participant.received.length ? participant.received.map(asset => asset.label).join(' · ') : 'no assets'}`}</Text>
                                            </View>
                                        ))}
                                    </View>
                                </Card>
                            </View>
                        )
                    })}
                </View>
            ) : (
                <EmptyState fullScreen={false} message="No completed trades yet." description="Completed trades in this league appear here." />
            )}
        </>
    )
}

const styles = StyleSheet.create({
    copy: { gap: spacing.xs },
    table: { overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm, gap: spacing.xs },
    managerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm, paddingVertical: spacing.md, gap: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight },
    team: { flex: 1, minWidth: 0 },
    count: { width: 72, textAlign: 'right', flexShrink: 0 },
    trades: { gap: spacing.md },
    trade: { gap: spacing.sm },
    tradeHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, flexWrap: 'wrap' },
    participants: { gap: spacing.sm },
    participant: { gap: spacing.xxs },
})
