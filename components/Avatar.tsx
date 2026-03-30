import { View, Text, Image, StyleSheet } from 'react-native'
import { colors, fontWeight } from '@/constants/tokens'
import { getInitials } from '@/lib/format'

type Props = {
    name: string
    color?: string
    /** Diameter in px (default 44) */
    size?: number
    /** Optional headshot image URI — shown instead of initials when provided */
    uri?: string | null
}

/** Circular avatar — shows headshot image when uri is provided, falls back to initials */
export function Avatar({ name, color = colors.primary, size = 44, uri }: Props) {
    const half = size / 2
    const fs = size <= 38 ? 12 : size <= 44 ? 14 : 18

    return (
        <View
            style={[
                styles.circle,
                { width: size, height: size, borderRadius: half, backgroundColor: color },
            ]}
        >
            {uri ? (
                <Image
                    source={{ uri }}
                    style={{ width: size, height: size, borderRadius: half }}
                    resizeMode="cover"
                />
            ) : (
                <Text style={[styles.text, { fontSize: fs }]}>{getInitials(name)}</Text>
            )}
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
