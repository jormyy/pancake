import { StyleSheet } from 'react-native'
import { colors, fontFamily, fontSize, fontWeight, layout, radii, spacing, table, textStyles } from '@/constants/tokens'
import { playerRowGeometry } from '@/components/PlayerSearchItem'

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
        minHeight: 38,
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
        minHeight: table.headerHeight,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: spacing.sm,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgSubtle,
    },
    tableHeaderAddSpacer: { width: playerRowGeometry.addColWidth },
    tableHeaderCardRow: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: spacing.sm,
        paddingRight: spacing.lg,
        gap: spacing.md,
    },
    tableHeaderHeadshotSpacer: { width: playerRowGeometry.headshot },
    tableHeaderPlayer: { ...textStyles.tableHeader, flex: 1 },
    tableHeaderOwnership: { ...textStyles.tableHeader, width: playerRowGeometry.statusWidth, textAlign: 'center' },
    tableHeaderStatsGroup: {
        width: playerRowGeometry.statCount * table.statColWidth,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
    },
    tableHeaderStatBtn: {
        width: table.statColWidth,
        minHeight: table.headerHeight,
        alignItems: 'flex-end',
        justifyContent: 'center',
    },
    tableHeaderStat: { ...textStyles.tableHeader, textAlign: 'right', color: colors.textSecondary },
    tableHeaderStatActive: {
        color: colors.primaryDark,
    },
    searchInput: {
        flex: 1,
        height: 44,
        minWidth: 0,
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.lg,
        fontSize: fontSize.lg,
        fontFamily: fontFamily.control,
        color: colors.textPrimary,
    },
    emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
})
