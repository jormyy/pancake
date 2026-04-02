import { View, Text, StyleSheet } from 'react-native'
import { POSITION_COLORS } from '@/constants/positions'
import { palette } from '@/constants/tokens'

export function PosTag({ position }: { position: string }) {
    const color = POSITION_COLORS[position] ?? palette.gray500
    return (
        <View style={[styles.posTag, { backgroundColor: color + '22' }]}>
            <Text style={[styles.posTagText, { color }]}>{position}</Text>
        </View>
    )
}

const styles = StyleSheet.create({
    posTag: { paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4, borderCurve: 'continuous' as const, flexShrink: 0 },
    posTagText: { fontSize: 9, fontWeight: '800' },
})
