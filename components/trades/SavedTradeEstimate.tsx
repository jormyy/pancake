import { StyleSheet, Text, View } from 'react-native'
import type { Trade } from '@/lib/trades'
import { colors, fontSize } from '@/constants/tokens'
import { displayedTradeValues, formatTradeValue } from '@/lib/trade-estimates'

export function SavedTradeEstimate({ trade, myMemberId }: { trade: Trade; myMemberId: string }) {
    const team = displayedTradeValues(trade, myMemberId)
    if (!team) return null
    const { comparison } = team
    const name = (id: string) => trade.participants.find(member => member.memberId === id)?.teamName
        ?? (id === trade.proposerMemberId ? trade.proposerTeamName : trade.recipientTeamName)
    return <View testID={`trade-saved-estimate-${trade.id}`}>
        {[...comparison.totals.filter(total => total.memberId === team.memberId), ...comparison.totals.filter(total => total.memberId !== team.memberId)].map(total => <Text key={total.memberId} style={styles.value}>{name(total.memberId)}: {formatTradeValue(total.total)} · Net {total.net > 0 ? '+' : ''}{formatTradeValue(total.net)}</Text>)}
        <Text style={styles.value}>{comparison.fair ? 'Fair' : `${name(comparison.winnerMemberId!)} wins`} · {formatTradeValue(comparison.gapPercent)}% gap</Text>
    </View>
}

const styles = StyleSheet.create({
    value: { fontSize: fontSize.xs, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
})
