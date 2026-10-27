import { ListHeader } from '@/components/ui/ListHeader'
import { View, Text, ScrollView, Pressable, StyleSheet, Platform } from 'react-native'
import { memo, useEffect, useRef } from 'react'
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
    error?: string | null
    onRetry?: () => void
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
    error,
    onRetry,
}: Props) {
    const endRef = useRef<View>(null)
    const pageKey = games.map(game => game.gameId).join(',')
    const automatic = compact && Platform.OS === 'web' && typeof IntersectionObserver !== 'undefined'
    useEffect(() => {
        if (!automatic || !hasMore || loading || loadingMore || error || typeof IntersectionObserver === 'undefined') return
        const sentinel = endRef.current as unknown as HTMLElement | null
        if (!sentinel) return
        let root = sentinel.parentElement
        while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) root = root.parentElement
        let requested = false
        const observer = new IntersectionObserver(entries => {
            if (!entries.some(entry => entry.isIntersecting) || requested) return
            requested = true
            onLoadMore()
        }, { root, rootMargin: '0px 0px 180px 0px' })
        observer.observe(sentinel)
        return () => observer.disconnect()
    }, [automatic, hasMore, loading, loadingMore, error, pageKey, onLoadMore])
    const showFpts = fantasyPointsMap !== null
    const { fadeStyle, scrollProps } = useEdgeFade()

    const rows = [...games].sort((a, b) => b.gameDate.localeCompare(a.gameDate))

    const dateCell = [styles.dateCell, compact && styles.compactDateCell]
    const oppCell = [styles.oppCell, compact && styles.compactOppCell]
    const fptsCell = [styles.fptsCell, compact && styles.compactFptsCell]
    const numCell = [compact ? styles.compactNumCell : styles.numCell]
    const content = (
        <View style={[styles.tableInner, compact && styles.compactTableInner]}>
            {/* Header row */}
            <ListHeader>
                <Text style={[...dateCell, styles.colHdr]}>DATE</Text>
                <Text style={[...oppCell, styles.colHdr]}>OPP</Text>
                {showFpts && <Text style={[...fptsCell, styles.colHdr]}>FP</Text>}
                <Text style={[...numCell, styles.colHdr]}>MIN</Text>
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
            </ListHeader>

            {/* Data rows */}
            {rows.map((g, i) => {
                const dnp = g.didNotPlay
                const fpts = dnp ? undefined : fantasyPointsMap?.get(g.gameId)
                return (
                    <View
                        testID={`game-log-row-${g.gameId}`}
                        key={'nbaGameId' in g && typeof g.nbaGameId === 'string' ? g.nbaGameId : g.gameId}
                        style={[styles.row, i < games.length - 1 && styles.rowDivider]}
                    >
                        <Text style={dateCell}>{fmtDate(g.gameDate)}</Text>
                        <Text style={oppCell} numberOfLines={1}>
                            {g.opponent || '—'}
                        </Text>
                        {showFpts && (
                            <Text style={[...fptsCell, fpts != null && styles.fptsValue]} numberOfLines={1}>
                                {dnp ? 'DNP' : (fpts ?? 0).toFixed(1)}
                            </Text>
                        )}
                        <Text style={numCell} testID={`game-minutes-${g.gameId}`}>
                            {dnp ? 'DNP' : g.minutes == null ? '—' : g.minutes.toFixed(1)}
                        </Text>
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
            {rows.length === 0 ? <View style={[styles.row, styles.emptyRow]}><Text style={styles.emptyText}>{loading ? 'Loading recent games…' : error ? 'Recent games unavailable.' : 'No games available.'}</Text></View> : null}
        </View>
    )

    return (
        <View style={styles.section} aria-busy={loading}>
            <Text style={textStyles.sectionLabel} role="heading" aria-level={2}>Recent games</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.tableFrame, fadeStyle]} contentContainerStyle={styles.tableContent} testID="recent-games-table" {...scrollProps}>
                {content}
            </ScrollView>
            <View ref={endRef} testID="game-log-end" style={styles.pageStatus}>
                {error && !loading ? <>
                    <Text style={styles.loadMoreText}>Could not load recent games. {error}</Text>
                    {onRetry ? <Pressable accessibilityRole="button" accessibilityLabel="Retry recent games" onPress={onRetry} style={styles.loadMoreBtn}>
                        <Text style={styles.loadMoreText}>Retry</Text>
                    </Pressable> : null}
                </> : loading || loadingMore ? rows.length > 0 ? <Text role="status" style={styles.loadMoreText}>Loading recent games…</Text> : null
                    : !hasMore && rows.length > 0 ? <Text style={styles.loadMoreText}>All games shown.</Text> : null}
            </View>
            {hasMore && !automatic && !error && (
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
    compactTableInner: { minWidth: 360 },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: table.rowHeightCompact,
        paddingHorizontal: table.cellPadX,
    },
    rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.separator },
    dateCell: { ...textStyles.tableCell, width: controlSize.minTouch + spacing.lg },
    oppCell: { ...textStyles.tableCell, width: controlSize.minTouch + spacing.xl, flexGrow: 1 },
    numCell: { ...textStyles.tableCell, width: spacing['4xl'] + spacing.xs, textAlign: 'center' },
    shotCell: { ...textStyles.tableCell, width: controlSize.button.lg.height, textAlign: 'center' },
    fptsCell: { ...textStyles.tableCell, width: controlSize.field.md, textAlign: 'center', color: colors.textPlaceholder },
    fptsValue: { color: colors.primaryDark, fontWeight: fontWeight.bold },

    compactDateCell: { width: controlSize.minTouch, fontSize: fontSize['2sm'] },
    compactOppCell: { width: controlSize.minTouch, flexGrow: 0, fontSize: fontSize['2sm'] },
    compactFptsCell: { width: table.statColWidth, fontSize: fontSize['2sm'] },
    compactNumCell: { ...textStyles.tableCell, flex: 1, minWidth: 0, textAlign: 'center', fontSize: fontSize['2sm'] },
    colHdr: { ...textStyles.tableHeader },
    dnpText: { color: colors.textPlaceholder },

    pageStatus: { minHeight: controlSize.minTouch, alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
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
