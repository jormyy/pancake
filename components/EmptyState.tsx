import { ComponentProps } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { colors, fontFamily, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
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
}

/** Centered empty state for empty lists / missing-data guards. Teaches + offers a CTA. */
export function EmptyState({ message, description, icon, actionLabel, onAction, fullScreen = true, framed }: Props) {
    return (
        <PromptFrame fullScreen={fullScreen} framed={framed}>
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
        </PromptFrame>
    )
}

const styles = StyleSheet.create({
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
        fontSize: fontSize.xl,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.black,
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
