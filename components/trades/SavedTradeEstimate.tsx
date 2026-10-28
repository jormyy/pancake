import { StyleSheet, Text } from 'react-native'
import type { Trade } from '@/lib/trades'
import { colors, fontSize } from '@/constants/tokens'
import { displayedTradeValues } from '@/lib/trade-estimates'

export function SavedTradeEstimate({ trade, myMemberId }: { trade: Trade; myMemberId: string }) {
    const team = displayedTradeValues(trade, myMemberId)
    if (!team) return null
    return <Text style={styles.value} testID={`trade-saved-estimate-${trade.id}`}>{team.valuesSent} vs {team.valuesReceived}</Text>
}

const styles = StyleSheet.create({
    value: { fontSize: fontSize.xs, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
})
