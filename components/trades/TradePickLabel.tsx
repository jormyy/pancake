import { StyleSheet, Text } from 'react-native'
import { colors, fontWeight, typeScale } from '@/constants/tokens'
import { tradePickLabel, type TradePickContext } from '@/lib/trade-pick-label'
import type { TradePickItem } from '@/lib/trades'

export function TradePickLabel({ pick, context, showDirection = true }: { pick: TradePickItem; context?: TradePickContext; showDirection?: boolean }) {
    const label = tradePickLabel(pick, context, showDirection)
    return <Text style={styles.label} accessibilityLabel={label} numberOfLines={1}>{label}</Text>
}

const styles = StyleSheet.create({
    label: { ...typeScale.small, color: colors.textPrimary, fontWeight: fontWeight.semibold, flexShrink: 1, minWidth: 0 },
})
