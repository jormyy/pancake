import { StyleSheet, Text } from 'react-native'
import { colors, fontSize, fontWeight } from '@/constants/tokens'
import { tradePickLabel, type TradePickContext } from '@/lib/trade-pick-label'
import type { TradePickItem } from '@/lib/trades'

export function TradePickLabel({ pick, context }: { pick: TradePickItem; context?: TradePickContext }) {
    const label = tradePickLabel(pick, context)
    return <Text style={styles.label} accessibilityLabel={label}>{label}</Text>
}

const styles = StyleSheet.create({
    label: { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold, flexShrink: 1 },
})
