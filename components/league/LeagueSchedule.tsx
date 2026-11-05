import { Text, View, StyleSheet } from 'react-native'
import { ScreenStatusScrollView } from '@/components/ui/ScreenStatusOverlay'
import { ListHeader } from '@/components/ui/ListHeader'
import { EmptyState } from '@/components/EmptyState'
import { usePageMetrics } from '@/components/ui'
import { Card } from '@/components/ui/Card'
import { MotionPressable } from '@/components/Motion'
import { colors, fontWeight, layout, spacing, table, textStyles } from '@/constants/tokens'
import { tableStyles } from '@/components/league/leagueTableStyles'
import type { LeagueScheduleRow } from '@/lib/cache/view-types'

function resultLabel(row: LeagueScheduleRow) {
    const score = `${row.myPoints ?? 0}–${row.opponentPoints ?? 0}`
    switch (row.status) {
        case 'skipped': return 'Skipped'
        case 'win': return `W ${score}`
        case 'loss': return `L ${score}`
        case 'tie': return `T ${score}`
        case 'live': return score
        case 'playoffs': return 'Playoffs'
        case 'pending': return 'Pending'
        default: return 'Upcoming'
    }
}

export function LeagueSchedule({ rows, onOpenMatchup }: { rows: LeagueScheduleRow[]; onOpenMatchup?: (matchupId: string) => void }) {
    const { padX } = usePageMetrics()
    if (!rows.length) return <EmptyState message="No schedule yet." description="Your matchups appear when the season schedule is ready." />
    return (
        <ScreenStatusScrollView contentContainerStyle={[styles.content, { paddingHorizontal: padX }]}>
            <Card padding="none" elevated="none" style={styles.card}>
            <ListHeader style={{ paddingHorizontal: padX }}>
                <Text style={[textStyles.tableHeader, styles.week]}>Week</Text>
                <Text style={[textStyles.tableHeader, styles.opponent]}>Opponent</Text>
                <Text style={[textStyles.tableHeader, styles.result]}>Result</Text>
            </ListHeader>
            <View role="list" aria-label="Your season schedule">
                {rows.map(row => {
                    const result = resultLabel(row)
                    const label = row.status === 'skipped' ? `Week ${row.weekNumber}, skipped` : `Week ${row.weekNumber}${row.isCurrent ? ', current week' : ''}${row.opponentTeamName ? `, ${row.opponentTeamName}` : ''}, ${row.status === 'live' ? 'Live ' : ''}${result}`
                    const content = <>
                        <View style={styles.week}>
                            <Text style={[textStyles.tableCell, row.isCurrent && tableStyles.textMe]}>{row.weekNumber}</Text>
                            {row.isCurrent ? <Text style={[textStyles.meta, tableStyles.textMe]}>Current</Text> : null}
                        </View>
                        <Text style={[textStyles.rowTitle, styles.opponent, row.status === 'skipped' && styles.placeholder]}>{row.status === 'skipped' ? 'No matchup' : row.opponentTeamName ?? (row.status === 'playoffs' ? '—' : 'To be decided')}</Text>
                        <View style={styles.result}>
                            <Text style={[textStyles.stat, row.status === 'win' && styles.win, row.status === 'loss' && styles.loss]}>{result}</Text>
                            {row.status === 'live' ? <Text style={[textStyles.tableHeader, styles.live]}>Live</Text> : null}
                        </View>
                    </>
                    return (
                        <View key={row.weekNumber} role="listitem" aria-label={label} accessibilityLabel={label}
                            style={[styles.row, { paddingHorizontal: padX }, row.isCurrent && tableStyles.rowMe]}>
                            {row.matchupId && onOpenMatchup ? <MotionPressable accessibilityRole="button" accessibilityLabel={`Open ${label}`} style={styles.action} onPress={() => onOpenMatchup(row.matchupId!)}>{content}</MotionPressable> : content}
                        </View>
                    )
                })}
            </View>
            </Card>
        </ScreenStatusScrollView>
    )
}

const styles = StyleSheet.create({
    content: { paddingTop: spacing.md, paddingBottom: spacing['3xl'] },
    card: { width: '100%', maxWidth: layout.formMaxWidth, alignSelf: 'center', overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', minHeight: table.rowHeight, paddingVertical: spacing.md, gap: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    action: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
    week: { width: table.statColWidth + spacing.md, flexShrink: 0, gap: spacing.xs },
    opponent: { flex: 1, minWidth: 0 },
    placeholder: { color: colors.textMuted },
    result: { alignItems: 'flex-end', textAlign: 'right', gap: spacing.xs },
    win: { color: colors.success, fontWeight: fontWeight.bold },
    loss: { color: colors.danger },
    live: { color: colors.primaryDark },
})
