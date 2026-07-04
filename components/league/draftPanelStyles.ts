import { StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

// Buttons, cards, and scroll containers shared across the league draft panels.
export const panelStyles = StyleSheet.create({
    draftButton: {
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        height: 44,
        justifyContent: 'center',
        alignItems: 'center',
    },
    draftButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 15 },
    secondaryDraftButton: {
        backgroundColor: colors.bgSubtle,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
        height: 44,
        justifyContent: 'center',
        alignItems: 'center',
    },
    secondaryDraftButtonText: { color: colors.textSecondary, fontWeight: fontWeight.bold, fontSize: 15 },
    panelScroll: {
        padding: spacing.xl,
        gap: spacing.lg,
        width: '100%',
        maxWidth: 760,
        alignSelf: 'center',
        paddingBottom: spacing['3xl'],
    },
    panelScrollCompactLandscape: { paddingBottom: 96 },
    panelCard: {
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        padding: spacing.xl,
        gap: spacing.md,
    },
    panelCardCompact: {
        padding: spacing.lg,
        gap: spacing.sm,
    },
    panelTitle: {
        fontSize: fontSize.lg,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    nominationModeLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0,
        marginBottom: spacing.xs,
    },
})
