import { StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight, layout, radii, spacing, textStyles } from '@/constants/tokens'

// Buttons, cards, and scroll containers shared across the league draft panels.
export const panelStyles = StyleSheet.create({
    draftButton: {
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        height: 44,
        paddingHorizontal: spacing.lg,
        justifyContent: 'center',
        alignItems: 'center',
    },
    draftButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },
    secondaryDraftButton: {
        backgroundColor: colors.bgSubtle,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
        height: 44,
        paddingHorizontal: spacing.lg,
        justifyContent: 'center',
        alignItems: 'center',
    },
    secondaryDraftButtonText: { color: colors.textSecondary, fontWeight: fontWeight.bold, fontSize: fontSize.md },
    // Left-aligned readable column under the page tabs. Panels add the page's
    // side padding from usePageMetrics().
    panelScroll: {
        paddingTop: spacing.lg,
        paddingBottom: spacing['3xl'],
        gap: spacing.xl,
        width: '100%',
        maxWidth: layout.formMaxWidth + 2 * layout.pagePadX.regular,
        alignSelf: 'center',
    },
    panelScrollCompactLandscape: { paddingBottom: spacing['6xl'] },
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
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },
    nominationModeLabel: {
        ...textStyles.sectionLabel,
        marginBottom: spacing.xs,
    },
})
