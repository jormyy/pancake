import { useEffect, useRef, useState } from 'react'
import { View, Text, Image, StyleSheet, Platform } from 'react-native'
import { colors, fontWeight } from '@/constants/tokens'
import { getInitials } from '@/lib/format'

const loadedImageUris = new Set<string>()

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
export function Avatar({ name, color = colors.bgMuted, textColor = colors.textSecondary, size = 44, uri }: Props) {
    const containerRef = useRef<View | null>(null)
    const [visibleUri, setVisibleUri] = useState(() => uri && loadedImageUris.has(uri) ? uri : null)
    const [failedUri, setFailedUri] = useState<string | null>(null)
    const half = size / 2
    const fs = size <= 38 ? 12 : size <= 44 ? 14 : 18

    useEffect(() => {
        setFailedUri(null)
        if (!uri) return
        if (loadedImageUris.has(uri) || Platform.OS !== 'web' || typeof IntersectionObserver === 'undefined') {
            setVisibleUri(uri)
            return
        }
        const container = containerRef.current
        if (!container) return
        let active = true
        const observer = new IntersectionObserver(entries => {
            if (active && entries.some(entry => entry.isIntersecting)) {
                setVisibleUri(uri)
                observer.disconnect()
            }
        }, { rootMargin: '128px' })
        observer.observe(container as unknown as Element)
        return () => {
            active = false
            observer.disconnect()
        }
    }, [uri])

    return (
        <View
            ref={containerRef}
            style={[
                styles.circle,
                { width: size, height: size, borderRadius: half, backgroundColor: color },
            ]}
        >
            {uri && uri === visibleUri && uri !== failedUri ? (
                <Image
                    source={{ uri }}
                    style={{ width: size, height: size, borderRadius: half }}
                    resizeMode="cover"
                    onLoad={() => {
                        loadedImageUris.add(uri)
                        if (loadedImageUris.size > 512) loadedImageUris.delete(loadedImageUris.values().next().value!)
                    }}
                    onError={() => setFailedUri(uri)}
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
