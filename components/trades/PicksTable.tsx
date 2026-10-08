import { StyleSheet, Text, View } from 'react-native'
import { colors, fontSize, fontWeight, radii, spacing, table, textStyles } from '@/constants/tokens'
import type { TradePickItem } from '@/lib/trades'

/**
 * Your draft picks as a season-by-round grid. A blank cell means that pick
 * belongs to another team now; a "via" chip is a pick you acquired.
 */
export function PicksTable({ picks, myTeamName }: { picks: TradePickItem[]; myTeamName: string }) {
    const seasons = [...new Set(picks.map((pick) => pick.seasonYear))].sort((a, b) => a - b)
    const roundCount = Math.max(1, ...picks.map((pick) => pick.round))
    const rounds = Array.from({ length: roundCount }, (_, index) => index + 1)

    return (
        <View style={styles.table} role="table" aria-label="Your draft picks by season and round">
            <View style={[styles.row, styles.headerRow]} role="row">
                <Text style={[styles.headerCell, styles.seasonCell]} role="columnheader">Season</Text>
                {rounds.map((round) => (
                    <Text key={round} style={[styles.headerCell, styles.roundCell]} role="columnheader">Round {round}</Text>
                ))}
            </View>
            {seasons.map((season, index) => (
                <View key={season} style={[styles.row, index === seasons.length - 1 && styles.lastRow]} role="row">
                    <Text style={[styles.seasonText, styles.seasonCell]} role="rowheader">{season}</Text>
                    {rounds.map((round) => {
                        const owned = picks
                            .filter((pick) => pick.seasonYear === season && pick.round === round)
                            .sort((left, right) => left.originalTeamName.localeCompare(right.originalTeamName))
                        return (
                            <View key={round} style={[styles.roundCell, styles.cell]} role="cell">
                                {owned.length === 0 ? (
                                    <Text style={styles.empty} accessibilityLabel={`No ${season} round ${round} pick`}>—</Text>
                                ) : owned.map((pick) => {
                                    const own = pick.originalTeamName === myTeamName
                                    return (
                                        <View key={pick.pickId} style={[styles.chip, !own && styles.chipAcquired]}>
                                            <Text style={[styles.chipText, !own && styles.chipTextAcquired]} numberOfLines={2}>
                                                {own ? 'Own' : `via ${pick.originalTeamName}`}
                                            </Text>
                                        </View>
                                    )
                                })}
                            </View>
                        )
                    })}
                </View>
            ))}
        </View>
    )
}

const styles = StyleSheet.create({
    table: {
        width: '100%',
        maxWidth: 720,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgCard,
        overflow: 'hidden',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: table.rowHeightCompact,
        paddingHorizontal: table.cellPadX,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    lastRow: { borderBottomWidth: 0 },
    headerRow: { minHeight: table.headerHeight, backgroundColor: colors.bgSubtle },
    headerCell: { ...textStyles.tableHeader },
    seasonCell: { width: 64, paddingHorizontal: table.cellPadX },
    roundCell: { flex: 1, minWidth: 0, paddingHorizontal: table.cellPadX },
    seasonText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textPrimary, fontVariant: ['tabular-nums'] as const },
    cell: { gap: spacing.xs, paddingVertical: spacing.sm, alignItems: 'flex-start' },
    empty: { ...textStyles.meta, color: colors.textDisabled },
    chip: {
        maxWidth: '100%',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xxs,
        borderRadius: radii.md,
        backgroundColor: colors.bgMuted,
    },
    chipAcquired: { backgroundColor: colors.primaryLight },
    chipText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    chipTextAcquired: { color: colors.primaryDark },
})
