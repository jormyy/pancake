import { View, Text, StyleSheet } from 'react-native'
import { colors, fontWeight } from '@/constants/tokens'
import { getInitials } from '@/lib/format'

type Props = {
    name: string
    color?: string
    /** Diameter in px (default 44) */
    size?: number
}

/** Circular initials avatar used in list rows */
export function Avatar({ name, color = colors.primary, size = 44 }: Props) {
    const half = size / 2
    const fs = size <= 38 ? 12 : size <= 44 ? 14 : 18

    return (
        <View
            style={[
                styles.circle,
                { width: size, height: size, borderRadius: half, backgroundColor: color },
            ]}
        >
            <Text style={[styles.text, { fontSize: fs }]}>{getInitials(name)}</Text>
        </View>
    )
}

const styles = StyleSheet.create({
    circle: {
        borderCurve: 'continuous',
        justifyContent: 'center',
        alignItems: 'center',
    },
    text: {
        color: colors.textWhite,
        fontWeight: fontWeight.bold,
    },
})
