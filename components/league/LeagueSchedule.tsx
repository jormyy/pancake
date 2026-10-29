import { Text, View, StyleSheet } from 'react-native'
import { ScreenStatusScrollView } from '@/components/ui/ScreenStatusOverlay'
import { ListHeader } from '@/components/ui/ListHeader'
import { EmptyState } from '@/components/EmptyState'
import { usePageMetrics } from '@/components/ui'
import { colors, fontWeight, spacing, table, textStyles } from '@/constants/tokens'
import { tableStyles } from '@/components/league/leagueTableStyles'
import type { LeagueScheduleRow } from '@/lib/cache/view-types'

function resultLabel(row: LeagueScheduleRow) {
    const score = `${row.myPoints ?? 0}–${row.opponentPoints ?? 0}`
    switch (row.status) {
        case 'win': return `W ${score}`
        case 'loss': return `L ${score}`
        case 'tie': return `T ${score}`
        case 'live': return score
        case 'playoffs': return 'Playoffs'
        case 'pending': return 'Pending'
        default: return 'Upcoming'
    }
}

export function LeagueSchedule({ rows }: { rows: LeagueScheduleRow[] }) {
    const { padX } = usePageMetrics()
    if (!rows.length) return <EmptyState message="No schedule yet." description="Your matchups appear when the season schedule is ready." />
    return (
        <ScreenStatusScrollView>
            <ListHeader style={{ paddingHorizontal: padX }}>
                <Text style={[textStyles.tableHeader, styles.week]}>Week</Text>
                <Text style={[textStyles.tableHeader, styles.opponent]}>Opponent</Text>
                <Text style={[textStyles.tableHeader, styles.result]}>Result</Text>
            </ListHeader>
            <View role="list" aria-label="Your season schedule">
                {rows.map(row => {
                    const result = resultLabel(row)
                    const label = `Week ${row.weekNumber}${row.isCurrent ? ', current week' : ''}${row.opponentTeamName ? `, ${row.opponentTeamName}` : ''}, ${row.status === 'live' ? 'Live ' : ''}${result}`
                    return (
                        <View key={row.weekNumber} role="listitem" aria-label={label} accessibilityLabel={label}
                            style={[styles.row, { paddingHorizontal: padX }, row.isCurrent && tableStyles.rowMe]}>
                            <View style={styles.week}>
                                <Text style={[textStyles.tableCell, row.isCurrent && tableStyles.textMe]}>{row.weekNumber}</Text>
                                {row.isCurrent ? <Text style={[textStyles.meta, tableStyles.textMe]}>Current</Text> : null}
                            </View>
                            <Text style={[textStyles.rowTitle, styles.opponent]}>{row.opponentTeamName ?? (row.status === 'playoffs' ? '—' : 'To be decided')}</Text>
                            <View style={styles.result}>
                                <Text style={[textStyles.stat, row.status === 'win' && styles.win, row.status === 'loss' && styles.loss]}>{result}</Text>
                                {row.status === 'live' ? <Text style={[textStyles.tableHeader, styles.live]}>Live</Text> : null}
                            </View>
                        </View>
                    )
                })}
            </View>
        </ScreenStatusScrollView>
    )
}

const styles = StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', minHeight: table.rowHeight, paddingVertical: spacing.md, gap: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    week: { width: table.statColWidth + spacing.md, flexShrink: 0, gap: spacing.xs },
    opponent: { flex: 1 },
    result: { alignItems: 'flex-end', textAlign: 'right', gap: spacing.xs },
    win: { color: colors.success, fontWeight: fontWeight.bold },
    loss: { color: colors.danger },
    live: { color: colors.primaryDark },
})
