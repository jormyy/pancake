import { View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
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
    const d = new Date(dateStr)
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
                <Text style={styles.sectionTitle}>Game Log</Text>
                <Text style={styles.noData}>No games found.</Text>
            </View>
        )
    }

    return (
        <View style={styles.section}>
            <Text style={styles.sectionTitle}>Game Log</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View>
                    {/* Header row */}
                    <View style={[styles.row, styles.headerRow]}>
                        <Text style={[styles.dateCell, styles.colHdr]}>DATE</Text>
                        <Text style={[styles.oppCell, styles.colHdr]}>OPP</Text>
                        <Text style={[styles.numCell, styles.colHdr]}>MIN</Text>
                        <Text style={[styles.numCell, styles.colHdr]}>PTS</Text>
                        <Text style={[styles.numCell, styles.colHdr]}>REB</Text>
                        <Text style={[styles.numCell, styles.colHdr]}>AST</Text>
                        <Text style={[styles.numCell, styles.colHdr]}>STL</Text>
                        <Text style={[styles.numCell, styles.colHdr]}>BLK</Text>
                        <Text style={[styles.numCell, styles.colHdr]}>TO</Text>
                        <Text style={[styles.shotCell, styles.colHdr]}>FG</Text>
                        <Text style={[styles.shotCell, styles.colHdr]}>3P</Text>
                        <Text style={[styles.shotCell, styles.colHdr]}>FT</Text>
                        <Text style={[styles.numCell, styles.colHdr]}>+/-</Text>
                        {showFpts && <Text style={[styles.fptsCell, styles.colHdr]}>FPTS</Text>}
                    </View>

                    {/* Data rows */}
                    {games.map((g, i) => {
                        const dnp = g.didNotPlay
                        const fpts = fantasyPointsMap?.get(g.gameId)
                        return (
                            <View
                                key={g.gameId}
                                style={[styles.row, i % 2 === 1 && styles.rowAlt]}
                            >
                                <Text style={styles.dateCell}>{fmtDate(g.gameDate)}</Text>
                                <Text style={styles.oppCell} numberOfLines={1}>
                                    {g.opponent || '—'}
                                </Text>
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
                                <Text style={styles.numCell}>{fmtStat(g.turnovers, dnp)}</Text>
                                <Text style={styles.shotCell}>{fmtShot(g.fgMade, g.fgAttempted, dnp)}</Text>
                                <Text style={styles.shotCell}>{fmtShot(g.threeMade, g.threeAttempted, dnp)}</Text>
                                <Text style={styles.shotCell}>{fmtShot(g.ftMade, g.ftAttempted, dnp)}</Text>
                                <Text style={styles.numCell}>{fmtPM(g.plusMinus, dnp)}</Text>
                                {showFpts && (
                                    <Text style={[styles.fptsCell, fpts != null && styles.fptsValue]}>
                                        {fpts != null ? fpts.toFixed(1) : ''}
                                    </Text>
                                )}
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
                >
                    {loadingMore ? (
                        <ActivityIndicator size="small" color={colors.primary} />
                    ) : (
                        <Text style={styles.loadMoreText}>Load More</Text>
                    )}
                </Pressable>
            )}
        </View>
    )
}

const styles = StyleSheet.create({
    section: { gap: 10 },
    sectionTitle: { fontSize: 17, fontWeight: fontWeight.bold, color: colors.textPrimary },
    noData: { color: colors.textPlaceholder, fontSize: fontSize.md },

    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 7,
        paddingHorizontal: 2,
    },
    headerRow: { borderBottomWidth: 1, borderBottomColor: colors.borderLight, paddingBottom: 6 },
    rowAlt: { backgroundColor: palette.gray50 },

    dateCell: { width: 58, fontSize: fontSize.sm, color: colors.textSecondary },
    oppCell: { width: 60, fontSize: fontSize.sm, color: palette.gray900 },
    numCell: { width: 38, textAlign: 'center', fontSize: fontSize.sm, color: palette.gray900 },
    shotCell: { width: 52, textAlign: 'center', fontSize: 12, color: palette.gray900 },
    fptsCell: { width: 46, textAlign: 'center', fontSize: fontSize.sm, color: colors.textPlaceholder },
    fptsValue: { color: colors.primary, fontWeight: fontWeight.semibold },

    colHdr: { fontSize: 10, fontWeight: fontWeight.bold, color: colors.textPlaceholder },
    dnpText: { color: colors.textPlaceholder },

    loadMoreBtn: {
        alignSelf: 'center',
        paddingHorizontal: spacing['2xl'],
        paddingVertical: 10,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        marginTop: spacing.xs,
        minWidth: 100,
        alignItems: 'center',
    },
    loadMoreText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textSecondary },
})
