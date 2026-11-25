import { StyleSheet } from 'react-native'
import { controlSize, colors, fontWeight, layout, radii, spacing, textStyles, typeScale } from '@/constants/tokens'

export const panelStyles = StyleSheet.create({
    draftButton: {
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        height: controlSize.minTouch,
        paddingHorizontal: spacing.lg,
        justifyContent: 'center',
        alignItems: 'center',
    },
    draftButtonText: { ...typeScale.row, color: colors.textWhite, fontWeight: fontWeight.bold },
    secondaryDraftButton: {
        backgroundColor: colors.bgSubtle,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
        height: controlSize.minTouch,
        paddingHorizontal: spacing.lg,
        justifyContent: 'center',
        alignItems: 'center',
    },
    secondaryDraftButtonText: { ...typeScale.row, color: colors.textSecondary, fontWeight: fontWeight.bold },
    // Left-aligned readable column under the page tabs. Panels add the page's
    // side padding from usePageMetrics().
    panelScroll: {
        paddingTop: spacing.md,
        paddingBottom: spacing.md,
        gap: spacing.md,
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
        ...typeScale.title,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },
    nominationModeLabel: {
        ...textStyles.sectionLabel,
        marginBottom: spacing.xs,
    },
})
