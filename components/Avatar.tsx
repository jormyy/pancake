import { useEffect, useState } from 'react'
import { View, Text, Image, StyleSheet } from 'react-native'
import { colors, fontWeight } from '@/constants/tokens'
import { getInitials } from '@/lib/format'

type Props = {
    name: string
    color?: string
    /** Initials color — pass a dark tone when `color` is a light fill (default white). */
    textColor?: string
    /** Diameter in px (default 44) */
    size?: number
    /** Optional headshot image URI — shown instead of initials when provided */
    uri?: string | null
}

/** Circular avatar — shows headshot image when uri is provided, falls back to initials */
export function Avatar({ name, color = colors.primary, textColor = colors.textWhite, size = 44, uri }: Props) {
    const [imageFailed, setImageFailed] = useState(false)
    const half = size / 2
    const fs = size <= 38 ? 12 : size <= 44 ? 14 : 18

    useEffect(() => {
        setImageFailed(false)
    }, [uri])

    return (
        <View
            style={[
                styles.circle,
                { width: size, height: size, borderRadius: half, backgroundColor: color },
            ]}
        >
            {uri && !imageFailed ? (
                <Image
                    source={{ uri }}
                    style={{ width: size, height: size, borderRadius: half }}
                    resizeMode="cover"
                    onError={() => setImageFailed(true)}
                />
            ) : (
                <Text style={[styles.text, { fontSize: fs, color: textColor }]}>{getInitials(name)}</Text>
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
