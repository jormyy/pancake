import { ComponentProps } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { Button } from '@/components/ui'

type IconName = ComponentProps<typeof MaterialIcons>['name']

type Props = {
    /** Primary line (legacy callers pass this as the only prop). */
    message: string
    /** Optional secondary line that teaches what belongs here / how to fill it. */
    description?: string
    /** Optional illustrative icon shown above the message. */
    icon?: IconName
    /** Optional CTA. */
    actionLabel?: string
    onAction?: () => void
    /** Wrap in SafeAreaView for full-screen usage (default: true) */
    fullScreen?: boolean
    /** Render the content inside a deliberate card even when not full-screen. */
    framed?: boolean
}

/** Centered empty state for empty lists / missing-data guards. Teaches + offers a CTA. */
export function EmptyState({ message, description, icon, actionLabel, onAction, fullScreen = true, framed }: Props) {
    // Full-screen / framed empty states get a contained card so they read as a
    // deliberate element on a wide desktop canvas instead of text in a void.
    const carded = fullScreen || framed
    const card = (
        <View style={carded ? styles.card : undefined}>
            {icon ? (
                <View style={styles.iconCircle}>
                    <MaterialIcons name={icon} size={28} color={colors.primary} />
                </View>
            ) : null}
            <Text style={styles.title}>{message}</Text>
            {description ? <Text style={styles.description}>{description}</Text> : null}
            {actionLabel && onAction ? (
                <Button title={actionLabel} variant="outline" onPress={onAction} style={styles.action} />
            ) : null}
        </View>
    )

    if (!fullScreen) return <View style={styles.inner}>{card}</View>

    return <SafeAreaView style={styles.container}><View style={styles.inner}>{card}</View></SafeAreaView>
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    inner: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing['3xl'], gap: spacing.md },
    card: {
        alignItems: 'center',
        gap: spacing.md,
        width: '100%',
        maxWidth: 440,
        paddingVertical: spacing['4xl'],
        paddingHorizontal: spacing['3xl'],
        borderRadius: radii.xl,
        borderCurve: 'continuous',
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
    },
    iconCircle: {
        width: 64,
        height: 64,
        borderRadius: radii.full,
        backgroundColor: colors.primaryLight,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: spacing.sm,
    },
    title: {
        color: colors.textSecondary,
        fontSize: fontSize.lg,
        fontWeight: fontWeight.bold,
        textAlign: 'center',
    },
    description: {
        color: colors.textMuted,
        fontSize: fontSize.md,
        textAlign: 'center',
        lineHeight: 20,
        maxWidth: 320,
    },
    action: { marginTop: spacing.sm },
})
