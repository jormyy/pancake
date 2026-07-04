import { StyleSheet, Text, View } from 'react-native'
import { brand, colors, elevation, fontFamily, fontSize, fontWeight, radii } from '@/constants/tokens'

export function AuthBrandMark({ compact = false }: { compact?: boolean }) {
    return (
        <View style={[styles.mark, compact && styles.markCompact]}>
            <Text style={[styles.text, compact && styles.textCompact]}>P</Text>
        </View>
    )
}

const styles = StyleSheet.create({
    mark: {
        width: 48,
        height: 48,
        borderRadius: radii.xl,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.primary,
        ...(elevation('brandGlowInset') as object),
    },
    markCompact: {
        width: 42,
        height: 42,
        borderRadius: radii.lg,
    },
    text: {
        color: brand.on,
        fontSize: fontSize['2xl'],
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
    },
    textCompact: { fontSize: 22 },
})
