import { Platform, StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight, layout, radii, spacing, srOnly } from '@/constants/tokens'

// Shared chrome for the Players + Projections screens (filter card, stat-table
// header, search input) — previously duplicated verbatim in both screens.
export const playerListStyles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    contentWrap: { flex: 1, width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center' },
    hiddenHeading: {
        ...srOnly,
    },
    filterCard: {
        margin: spacing.xl,
        marginBottom: spacing.md,
        padding: spacing.lg,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        backgroundColor: colors.bgCard,
        gap: spacing.lg,
        ...(Platform.OS === 'web' ? { boxShadow: '0 10px 28px rgba(74, 37, 9, 0.08)' } : {}),
    },
    filterCardTop: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
    },
    filterCardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md,
    },
    filterCardTitle: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
        letterSpacing: 0.6,
        textTransform: 'uppercase' as const,
    },
    filterToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: 32,
    },
    filterCountDot: {
        minWidth: 20,
        height: 20,
        paddingHorizontal: 6,
        borderRadius: radii.full,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    filterCountDotText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textWhite },
    resultCountText: {
        flexShrink: 0,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
    },
    filterGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.md,
    },
    filterSelectCaret: {
        flexShrink: 0,
        fontSize: fontSize.xs,
        color: colors.textMuted,
    },
    sortDirButton: {
        minHeight: 38,
        alignSelf: 'flex-end',
        justifyContent: 'center',
        borderRadius: radii.md,
        backgroundColor: colors.bgMuted,
        paddingHorizontal: spacing.lg,
    },
    sortDirText: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
    },
    tableHeader: {
        minHeight: 34,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: spacing.lg,    // mirrors playerRow.paddingLeft
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgSubtle,
    },
    tableHeaderAddSpacer: { width: 36 },    // mirrors addCol.width
    tableHeaderCardRow: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: spacing.md,    // mirrors playerCard.paddingLeft
        paddingRight: spacing['4xl'], // mirrors playerCard.paddingRight
        gap: spacing.lg,            // mirrors playerCard.gap
    },
    tableHeaderHeadshotSpacer: { width: 44 },  // mirrors headshot.width
    tableHeaderPlayer: {
        flex: 1,                    // mirrors playerInfo flex: 1
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        letterSpacing: 0.8,
        textTransform: 'uppercase' as const,
    },
    tableHeaderOwnership: {
        width: 90,                  // mirrors statusBadge.width
        textAlign: 'center',
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        letterSpacing: 0.7,
        textTransform: 'uppercase' as const,
    },
    tableHeaderStatsGroup: {
        width: 9 * 54,              // mirrors statsGrid.width
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end', // mirrors statsGrid.justifyContent
    },
    tableHeaderStatBtn: {
        width: 54,                  // mirrors statCell.width
        minHeight: 34,
        alignItems: 'flex-end',
        justifyContent: 'center',
    },
    tableHeaderStat: {
        textAlign: 'right',
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.extrabold,
        color: colors.textSecondary,
        letterSpacing: 0.7,
        textTransform: 'uppercase' as const,
    },
    tableHeaderStatActive: {
        color: colors.primaryDark,
    },
    searchInput: {
        flex: 1,
        height: 44,
        backgroundColor: colors.bgMuted,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.lg + spacing.xxs,
        fontSize: fontSize.lg,
        color: colors.textPrimary,
    },
    clearAllChip: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.dangerLight,
    },
    clearAllChipText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.dangerDark },
    emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
})
