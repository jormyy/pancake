import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native'
import { memo } from 'react'
import { colors, controlSize, fontSize, fontWeight, radii, spacing, table, textStyles } from '@/constants/tokens'
import type { GameLogEntry } from '@/lib/players'
import { useEdgeFade } from '@/components/ui/useEdgeFade'

type Props = {
    games: GameLogEntry[]
    fantasyPointsMap: Map<string, number> | null
    hasMore: boolean
    loadingMore: boolean
    onLoadMore: () => void
    loading?: boolean
    compact?: boolean
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

export const GameLogTable = memo(function GameLogTable({
    games,
    fantasyPointsMap,
    hasMore,
    loadingMore,
    onLoadMore,
    loading = false,
    compact = false,
}: Props) {
    const showFpts = fantasyPointsMap !== null
    const { fadeStyle, scrollProps } = useEdgeFade()

    const rows = [...games].sort((a, b) => b.gameDate.localeCompare(a.gameDate))

    const dateCell = [styles.dateCell, compact && styles.compactDateCell]
    const oppCell = [styles.oppCell, compact && styles.compactOppCell]
    const fptsCell = [styles.fptsCell, compact && styles.compactFptsCell]
    const numCell = [compact ? styles.compactNumCell : styles.numCell]
    const content = (
        <View style={styles.tableInner}>
            {/* Header row */}
            <View style={[styles.row, styles.headerRow]}>
                <Text style={[...dateCell, styles.colHdr]}>DATE</Text>
                <Text style={[...oppCell, styles.colHdr]}>OPP</Text>
                {showFpts && <Text style={[...fptsCell, styles.colHdr]}>FP</Text>}
                {!compact && <Text style={[...numCell, styles.colHdr]}>MIN</Text>}
                <Text style={[...numCell, styles.colHdr]}>PTS</Text>
                <Text style={[...numCell, styles.colHdr]}>REB</Text>
                <Text style={[...numCell, styles.colHdr]}>AST</Text>
                <Text style={[...numCell, styles.colHdr]}>STL</Text>
                <Text style={[...numCell, styles.colHdr]}>BLK</Text>
                <Text style={[...numCell, styles.colHdr]}>3PM</Text>
                <Text style={[...numCell, styles.colHdr]}>TO</Text>
                {!compact && <>
                    <Text style={[styles.shotCell, styles.colHdr]}>FG</Text>
                    <Text style={[styles.shotCell, styles.colHdr]}>FT</Text>
                    <Text style={[...numCell, styles.colHdr]}>+/-</Text>
                </>}
            </View>

            {/* Data rows */}
            {rows.map((g, i) => {
                const dnp = g.didNotPlay
                const fpts = dnp ? undefined : fantasyPointsMap?.get(g.gameId)
                return (
                    <View
                        key={'nbaGameId' in g && typeof g.nbaGameId === 'string' ? g.nbaGameId : g.gameId}
                        style={[styles.row, i < games.length - 1 && styles.rowDivider]}
                    >
                        <Text style={dateCell}>{fmtDate(g.gameDate)}</Text>
                        <Text style={oppCell} numberOfLines={1}>
                            {g.opponent || '—'}
                        </Text>
                        {showFpts && (
                            <Text style={[...fptsCell, fpts != null && styles.fptsValue]}>
                                {dnp && compact ? 'DNP' : fpts != null ? fpts.toFixed(1) : ''}
                            </Text>
                        )}
                        {!compact && <Text style={numCell}>
                            {dnp ? 'DNP' : g.minutes.toFixed(1)}
                        </Text>}
                        <Text style={[...numCell, dnp && styles.dnpText]}>
                            {dnp ? compact && !showFpts ? 'DNP' : '' : g.points}
                        </Text>
                        <Text style={numCell}>{fmtStat(g.rebounds, dnp)}</Text>
                        <Text style={numCell}>{fmtStat(g.assists, dnp)}</Text>
                        <Text style={numCell}>{fmtStat(g.steals, dnp)}</Text>
                        <Text style={numCell}>{fmtStat(g.blocks, dnp)}</Text>
                        <Text style={numCell}>{fmtStat(g.threeMade, dnp)}</Text>
                        <Text style={numCell}>{fmtStat(g.turnovers, dnp)}</Text>
                        {!compact && <>
                            <Text style={styles.shotCell}>{fmtShot(g.fgMade, g.fgAttempted, dnp)}</Text>
                            <Text style={styles.shotCell}>{fmtShot(g.ftMade, g.ftAttempted, dnp)}</Text>
                            <Text style={numCell}>{fmtPM(g.plusMinus, dnp)}</Text>
                        </>}
                    </View>
                )
            })}
            {rows.length === 0 ? <View style={[styles.row, styles.emptyRow]}><Text style={styles.emptyText}>{loading ? 'Loading recent games…' : 'No games available.'}</Text></View> : null}
        </View>
    )

    return (
        <View style={styles.section} aria-busy={loading}>
            <Text style={textStyles.sectionLabel} role="heading" aria-level={2}>Recent games</Text>
            {compact ? <View style={styles.tableFrame} testID="recent-games-table">{content}</View> : (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.tableFrame, fadeStyle]} contentContainerStyle={styles.tableContent} {...scrollProps}>
                    {content}
                </ScrollView>
            )}
            {hasMore && (
                <Pressable
                    style={styles.loadMoreBtn}
                    onPress={onLoadMore}
                    disabled={loadingMore || loading}
                    accessibilityRole="button"
                    accessibilityLabel="Load more games"
                    accessibilityState={{ disabled: loadingMore || loading, busy: loadingMore || loading }}
                >
                    <Text style={styles.loadMoreText}>{loadingMore ? 'Loading…' : 'Load more games'}</Text>
                </Pressable>
            )}
        </View>
    )
})

const styles = StyleSheet.create({
    section: { gap: spacing.md },
    emptyRow: { minHeight: table.rowHeightCompact },
    emptyText: { ...textStyles.meta },

    tableFrame: {
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgCard,
        overflow: 'hidden',
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

    dateCell: { ...textStyles.tableCell, width: controlSize.minTouch + spacing.lg },
    oppCell: { ...textStyles.tableCell, width: controlSize.minTouch + spacing.xl, flexGrow: 1 },
    numCell: { ...textStyles.tableCell, width: spacing['4xl'] + spacing.xs, textAlign: 'center' },
    shotCell: { ...textStyles.tableCell, width: controlSize.button.lg.height, textAlign: 'center' },
    fptsCell: { ...textStyles.tableCell, width: controlSize.field.md, textAlign: 'center', color: colors.textPlaceholder },
    fptsValue: { color: colors.primaryDark, fontWeight: fontWeight.bold },

    compactDateCell: { width: controlSize.minTouch, fontSize: fontSize['2sm'] },
    compactOppCell: { width: controlSize.minTouch, flexGrow: 0, fontSize: fontSize['2sm'] },
    compactFptsCell: { width: spacing['4xl'] + spacing.xs, fontSize: fontSize['2sm'] },
    compactNumCell: { ...textStyles.tableCell, flex: 1, minWidth: 0, textAlign: 'center', fontSize: fontSize['2sm'] },
    colHdr: { ...textStyles.tableHeader },
    dnpText: { color: colors.textPlaceholder },

    loadMoreBtn: {
        alignSelf: 'center',
        minHeight: table.rowHeightCompact,
        minWidth: controlSize.minTouch * 2 + spacing['4xl'],
        paddingHorizontal: spacing['2xl'],
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        alignItems: 'center',
        justifyContent: 'center',
    },
    loadMoreText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
})
