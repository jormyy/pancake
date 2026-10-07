import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight, radii, spacing, table, textStyles } from '@/constants/tokens'
import type { GameLogEntry } from '@/lib/players'

type Props = {
    games: GameLogEntry[]
    fantasyPointsMap: Map<string, number> | null
    hasMore: boolean
    loadingMore: boolean
    onLoadMore: () => void
}

function fmtDate(dateStr: string): string {
    if (!dateStr) return '—'
    const [, month, day] = dateStr.split('-').map(Number)
    const d = new Date(2000, month - 1, day)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function fmtStat(val: number, dnp: boolean): string {
    if (dnp) return ''
    return String(val)
}

function fmtShot(made: number, attempted: number, dnp: boolean): string {
    if (dnp) return ''
    return `${made}-${attempted}`
}

function fmtPM(val: number, dnp: boolean): string {
    if (dnp) return ''
    if (val > 0) return `+${val}`
    return String(val)
}

export function GameLogTable({
    games,
    fantasyPointsMap,
    hasMore,
    loadingMore,
    onLoadMore,
}: Props) {
    const showFpts = fantasyPointsMap !== null

    if (games.length === 0) {
        return (
            <View style={styles.section}>
                <Text style={textStyles.sectionLabel} role="heading" aria-level={2}>Game Log</Text>
                <Text style={styles.noData}>No games found.</Text>
            </View>
        )
    }

    return (
        <View style={styles.section}>
            <Text style={textStyles.sectionLabel} role="heading" aria-level={2}>Game Log</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tableFrame} contentContainerStyle={styles.tableContent}>
                <View style={styles.tableInner}>
                    {/* Header row */}
                    <View style={[styles.row, styles.headerRow]}>
                        <Text style={[styles.dateCell, styles.colHdr]}>DATE</Text>
                        <Text style={[styles.oppCell, styles.colHdr]}>OPP</Text>
                        {showFpts && <Text style={[styles.fptsCell, styles.colHdr]}>FP</Text>}
                        <Text style={[styles.numCell, styles.colHdr]}>MIN</Text>
                        <Text style={[styles.numCell, styles.colHdr]}>PTS</Text>
                        <Text style={[styles.numCell, styles.colHdr]}>REB</Text>
                        <Text style={[styles.numCell, styles.colHdr]}>AST</Text>
                        <Text style={[styles.numCell, styles.colHdr]}>STL</Text>
                        <Text style={[styles.numCell, styles.colHdr]}>BLK</Text>
                        <Text style={[styles.numCell, styles.colHdr]}>3PM</Text>
                        <Text style={[styles.numCell, styles.colHdr]}>TO</Text>
                        <Text style={[styles.shotCell, styles.colHdr]}>FG</Text>
                        <Text style={[styles.shotCell, styles.colHdr]}>FT</Text>
                        <Text style={[styles.numCell, styles.colHdr]}>+/-</Text>
                    </View>

                    {/* Data rows */}
                    {games.map((g, i) => {
                        const dnp = g.didNotPlay
                        const fpts = fantasyPointsMap?.get(g.gameId)
                        return (
                            <View
                                key={g.gameId}
                                style={[styles.row, i < games.length - 1 && styles.rowDivider]}
                            >
                                <Text style={styles.dateCell}>{fmtDate(g.gameDate)}</Text>
                                <Text style={styles.oppCell} numberOfLines={1}>
                                    {g.opponent || '—'}
                                </Text>
                                {showFpts && (
                                    <Text style={[styles.fptsCell, fpts != null && styles.fptsValue]}>
                                        {fpts != null ? fpts.toFixed(1) : ''}
                                    </Text>
                                )}
                                <Text style={styles.numCell}>
                                    {dnp ? 'DNP' : Math.round(g.minutes)}
                                </Text>
                                <Text style={[styles.numCell, dnp && styles.dnpText]}>
                                    {dnp ? '' : g.points}
                                </Text>
                                <Text style={styles.numCell}>{fmtStat(g.rebounds, dnp)}</Text>
                                <Text style={styles.numCell}>{fmtStat(g.assists, dnp)}</Text>
                                <Text style={styles.numCell}>{fmtStat(g.steals, dnp)}</Text>
                                <Text style={styles.numCell}>{fmtStat(g.blocks, dnp)}</Text>
                                <Text style={styles.numCell}>{fmtStat(g.threeMade, dnp)}</Text>
                                <Text style={styles.numCell}>{fmtStat(g.turnovers, dnp)}</Text>
                                <Text style={styles.shotCell}>{fmtShot(g.fgMade, g.fgAttempted, dnp)}</Text>
                                <Text style={styles.shotCell}>{fmtShot(g.ftMade, g.ftAttempted, dnp)}</Text>
                                <Text style={styles.numCell}>{fmtPM(g.plusMinus, dnp)}</Text>
                            </View>
                        )
                    })}
                </View>
            </ScrollView>

            {hasMore && (
                <Pressable
                    style={styles.loadMoreBtn}
                    onPress={onLoadMore}
                    disabled={loadingMore}
                    accessibilityRole="button"
                    accessibilityLabel="Load more games"
                >
                    <Text style={styles.loadMoreText}>Load More</Text>
                </Pressable>
            )}
        </View>
    )
}

const styles = StyleSheet.create({
    section: { gap: spacing.md },
    noData: { ...textStyles.body, color: colors.textPlaceholder },

    tableFrame: {
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgCard,
    },
    // Fill the frame on wide screens; scroll sideways when the columns don't fit.
    tableContent: { flexGrow: 1 },
    tableInner: { flexGrow: 1 },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: table.rowHeightCompact,
        paddingHorizontal: table.cellPadX,
    },
    rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.separator },
    headerRow: {
        minHeight: table.headerHeight,
        backgroundColor: colors.bgSubtle,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },

    dateCell: { ...textStyles.tableCell, width: 60 },
    oppCell: { ...textStyles.tableCell, width: 64, flexGrow: 1 },
    numCell: { ...textStyles.tableCell, width: 40, textAlign: 'center' },
    shotCell: { ...textStyles.tableCell, width: 52, textAlign: 'center' },
    fptsCell: { ...textStyles.tableCell, width: 48, textAlign: 'center', color: colors.textPlaceholder },
    fptsValue: { color: colors.primaryDark, fontWeight: fontWeight.bold },

    colHdr: { ...textStyles.tableHeader },
    dnpText: { color: colors.textPlaceholder },

    loadMoreBtn: {
        alignSelf: 'center',
        minHeight: table.rowHeightCompact,
        minWidth: 120,
        paddingHorizontal: spacing['2xl'],
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        alignItems: 'center',
        justifyContent: 'center',
    },
    loadMoreText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
})
