import { View, Text, StyleSheet } from 'react-native'
import { slotColor } from '@/constants/positions'
import { alpha, componentTokens, fontWeight } from '@/constants/tokens'

/** Small position tag, tinted like the Matchup and Roster slot chips. */
export function PosTag({ position }: { position: string }) {
    const color = slotColor(position)
    return (
        <View testID="position-chip" style={[styles.pill, { backgroundColor: alpha(color, 0.13) }]}>
            <Text style={[styles.label, { color }]}>{position}</Text>
        </View>
    )
}

const styles = StyleSheet.create({
    pill: {
        minHeight: componentTokens.badge.position.minHeight,
        paddingHorizontal: componentTokens.badge.position.paddingHorizontal,
        paddingVertical: componentTokens.badge.position.paddingVertical,
        borderRadius: componentTokens.badge.position.borderRadius,
        borderCurve: 'continuous',
    },
    label: { ...componentTokens.badge.position.label, fontWeight: fontWeight.black },
})
