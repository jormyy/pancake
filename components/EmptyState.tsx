import { ComponentProps } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { colors, controlSize, fontFamily, fontSize, fontWeight, radii, spacing, textStyles, lineHeight } from '@/constants/tokens'
import { Button } from '@/components/ui'
import { PromptFrame } from '@/components/ui/PromptFrame'

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
    reserveCopy?: { message: string; description: string }
}

/** Centered empty state for empty lists / missing-data guards. Teaches + offers a CTA. */
export function EmptyState({ message, description, icon, actionLabel, onAction, fullScreen = true, framed, reserveCopy }: Props) {
    if (!fullScreen) {
        return (
            <View style={styles.inline}>
                <Text style={styles.inlineText}>{message}</Text>
                {description ? <Text style={styles.description}>{description}</Text> : null}
                {actionLabel && onAction ? <Button title={actionLabel} variant="outline" size="sm" onPress={onAction} /> : null}
            </View>
        )
    }

    return (
        <PromptFrame fullScreen={fullScreen} framed={framed}>
            {icon ? (
                <View style={styles.iconCircle}>
                    <MaterialIcons name={icon} size={controlSize.icon.lg} color={colors.primary} />
                </View>
            ) : null}
            {reserveCopy ? (
                <View style={styles.reservedTitle}>
                    <Text style={[styles.title, styles.copyMeasure]} aria-hidden accessibilityElementsHidden>{reserveCopy.message}</Text>
                    <Text style={[styles.title, styles.copyOverlay]}>{message}</Text>
                </View>
            ) : <Text style={styles.title}>{message}</Text>}
            {description ? reserveCopy ? (
                <View style={styles.reservedDescription}>
                    <Text style={[styles.description, styles.copyMeasure]} aria-hidden accessibilityElementsHidden>{reserveCopy.description}</Text>
                    <Text style={[styles.description, styles.copyOverlay]}>{description}</Text>
                </View>
            ) : <Text style={styles.description}>{description}</Text> : null}
            {actionLabel && onAction ? (
                <Button title={actionLabel} variant="outline" onPress={onAction} style={styles.action} />
            ) : null}
        </PromptFrame>
    )
}

const styles = StyleSheet.create({
    inline: { alignItems: 'center', paddingVertical: spacing.lg, gap: spacing.sm },
    inlineText: { ...textStyles.body, color: colors.textMuted, textAlign: 'center' },
    iconCircle: {
        width: controlSize.minTouch,
        height: controlSize.minTouch,
        borderRadius: radii.full,
        backgroundColor: colors.primaryLight,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: spacing.sm,
    },
    title: {
        color: colors.textSecondary,
        fontSize: fontSize.md,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.black,
        textAlign: 'center',
    },
    description: {
        color: colors.textMuted,
        fontSize: fontSize.md,
        textAlign: 'center',
        lineHeight: lineHeight.control,
        maxWidth: 320,
    },
    reservedTitle: { width: '100%' },
    reservedDescription: { width: '100%', maxWidth: 320 },
    copyMeasure: { opacity: 0 },
    copyOverlay: { position: 'absolute', top: spacing.none, left: spacing.none, right: spacing.none },
    action: { marginTop: spacing.sm },
})
