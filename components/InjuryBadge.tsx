import { View, Text, StyleSheet } from 'react-native'
import { colors, palette } from '@/constants/tokens'

export function InjuryBadge({ status }: { status: string | null }) {
    if (!status) return null
    const s = status.toLowerCase()
    let label = status.toUpperCase()
    let color: string = colors.textPlaceholder
    if (s === 'out') { color = colors.danger; label = 'OUT' }
    else if (s.startsWith('ir')) { color = palette.red900; label = 'IR' }
    else if (s === 'gtd' || s === 'game time decision') { color = palette.amber600; label = 'GTD' }
    else if (s === 'd-td' || s === 'day-to-day') { color = colors.primary; label = 'D-TD' }
    else return null

    return (
        <View style={[styles.injuryBadge, { backgroundColor: color + '22' }]}>
            <Text style={[styles.injuryBadgeText, { color }]}>{label}</Text>
        </View>
    )
}

const styles = StyleSheet.create({
    injuryBadge: { paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4, flexShrink: 0 },
    injuryBadgeText: { fontSize: 9, fontWeight: '800' },
})
