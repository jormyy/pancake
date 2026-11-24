import { Pressable, StyleSheet, Text } from 'react-native'
import { colors, fontWeight, spacing, typeScale } from '@/constants/tokens'

type Props = {
    message?: string
    onRetry: () => void
}

export function ErrorBanner({ message = 'Failed to load. Tap to retry.', onRetry }: Props) {
    return (
        <Pressable
            style={styles.banner}
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel={message}
            accessibilityLiveRegion="polite"
        >
            <Text style={styles.text}>{message}</Text>
        </Pressable>
    )
}

const styles = StyleSheet.create({
    banner: {
        backgroundColor: colors.dangerLight,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    text: {
        ...typeScale.small,
        fontWeight: fontWeight.semibold,
        color: colors.dangerDark,
        textAlign: 'center',
    },
})
