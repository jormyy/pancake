import { StyleSheet } from 'react-native'
import { colors, componentTokens, controlSize, fontFamily, fontSize, fontWeight, layout, radii, spacing, table, textStyles } from '@/constants/tokens'

// Shared chrome for the Players screen: stat-table header, search input, and
// sort control.
export const playerListStyles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    contentWrap: { flex: 1, width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center' },
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
    sortDirButton: {
        minHeight: controlSize.minTouch,
        alignSelf: 'flex-end',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgCard,
        paddingHorizontal: spacing.lg,
    },
    sortDirText: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
    },
    // Each width mirrors PlayerSearchItem's row geometry so columns line up.
    tableHeader: {
        paddingLeft: spacing.sm,
        borderTopWidth: 1,
        borderColor: colors.borderLight,
    },
    tableHeaderAddSpacer: { width: componentTokens.playerRow.actionWidth },
    tableHeaderCardRow: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: spacing.sm,
        paddingRight: spacing.lg,
        gap: spacing.md,
    },
    tableHeaderHeadshotSpacer: { width: componentTokens.playerRow.standard.avatarSize },
    tableHeaderPlayer: { ...textStyles.tableHeader, flex: 1 },
    tableHeaderStatsGroup: {
        width: componentTokens.playerRow.statCount * table.statColWidth,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
    },
    tableHeaderStatBtn: {
        width: table.statColWidth,
        minHeight: controlSize.minTouch,
        alignItems: 'flex-end',
        justifyContent: 'center',
    },
    tableHeaderStat: { ...textStyles.tableHeader, textAlign: 'right', color: colors.textSecondary },
    tableHeaderStatActive: {
        color: colors.primaryDark,
    },
    searchInput: {
        flex: 1,
        minHeight: controlSize.field.md,
        minWidth: 0,
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.lg,
        fontSize: controlSize.field.fontSize,
        fontFamily: fontFamily.control,
        color: colors.textPrimary,
    },
    emptyContainer: { flexGrow: 1 },
})
