import { View, Text, Pressable, StyleSheet } from 'react-native'
import type { ErrorBoundaryProps } from 'expo-router'
import { colors, fontFamily, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

// Rendered by expo-router when a route's own render throws. Because it hangs off
// the route (not the navigator), the nav shell and routing stay alive — the
// crash is contained to this one screen instead of blanking the whole app, and
// "Try again" re-renders the route.
export function ScreenErrorFallback({ error, retry }: ErrorBoundaryProps) {
    return (
        <View style={styles.container}>
            <Text style={styles.title}>Something went wrong</Text>
            <Text style={styles.body}>
                This screen hit an unexpected error. Your data is safe — try again, or switch to
                another screen.
            </Text>
            {__DEV__ && error?.message ? <Text style={styles.detail}>{error.message}</Text> : null}
            <Pressable
                style={styles.button}
                onPress={() => { void retry() }}
                accessibilityRole="button"
                accessibilityLabel="Try again"
            >
                <Text style={styles.buttonText}>Try again</Text>
            </Pressable>
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: spacing.xl,
        gap: spacing.md,
        backgroundColor: colors.bgScreen,
    },
    title: {
        fontSize: fontSize.xl,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },
    body: {
        fontSize: fontSize.sm,
        color: colors.textSecondary,
        textAlign: 'center',
        maxWidth: 420,
    },
    detail: {
        fontSize: fontSize.xs,
        color: colors.textMuted,
        textAlign: 'center',
        maxWidth: 420,
    },
    button: {
        marginTop: spacing.sm,
        minHeight: 44,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.xl,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
    },
    buttonText: {
        color: colors.textWhite,
        fontWeight: fontWeight.bold,
        fontSize: fontSize.md,
    },
})
