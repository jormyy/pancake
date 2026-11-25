import { useEffect, useRef } from 'react'
import { Text, View, StyleSheet } from 'react-native'
import { ScreenStatusScrollView } from '@/components/ui/ScreenStatusOverlay'
import { ListHeader } from '@/components/ui/ListHeader'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/EmptyState'
import { usePageMetrics } from '@/components/ui'
import { Card } from '@/components/ui/Card'
import { SectionBand } from '@/components/ui/SectionBand'
import { MotionPressable } from '@/components/Motion'
import { colors, controlSize, fontWeight, layout, spacing, table, textStyles } from '@/constants/tokens'
import { tableStyles } from '@/components/league/leagueTableStyles'
import { formatPoints } from '@/lib/format-points'
import type { LeagueScheduleRow } from '@/lib/cache/view-types'

const OUTCOME: Partial<Record<LeagueScheduleRow['status'], string>> = { win: 'W', loss: 'L', tie: 'T', live: 'Live' }
const STATUS: Partial<Record<LeagueScheduleRow['status'], string>> = { skipped: 'Skipped', playoffs: 'Playoffs', pending: 'Pending', upcoming: 'Upcoming' }

function resultLabel(row: LeagueScheduleRow) {
    const score = `${formatPoints(row.myPoints ?? 0)}–${formatPoints(row.opponentPoints ?? 0)}`
    if (row.status === 'live') return score
    return OUTCOME[row.status] ? `${OUTCOME[row.status]} ${score}` : STATUS[row.status] ?? 'Upcoming'
}

export function LeagueSchedule({ rows, onOpenMatchup }: { rows: LeagueScheduleRow[]; onOpenMatchup?: (matchupId: string) => void }) {
    const { padX } = usePageMetrics()
    const currentRow = useRef<View & { scrollIntoView?: (options: ScrollIntoViewOptions) => void }>(null)
    const hasRows = rows.length > 0
    useEffect(() => {
        if (hasRows) currentRow.current?.scrollIntoView?.({ block: 'nearest' })
    }, [hasRows])
    if (!rows.length) return <EmptyState message="No schedule yet." description="Your matchups appear when the season schedule is ready." />
    return (
        <ScreenStatusScrollView contentContainerStyle={[styles.content, { paddingHorizontal: padX }]}>
            <Card padding="none" elevated="none" style={styles.card}>
            <SectionBand label="Schedule" />
            <ListHeader style={{ paddingHorizontal: spacing.lg }}>
                <Text style={[textStyles.tableHeader, styles.week]}>Week</Text>
                <Text style={[textStyles.tableHeader, styles.opponent]}>Opponent</Text>
                <Text style={[textStyles.tableHeader, styles.result]}>Result</Text>
            </ListHeader>
            <View role="list" aria-label="Your season schedule">
                {rows.map(row => {
                    const result = resultLabel(row)
                    const outcome = OUTCOME[row.status]
                    const label = row.status === 'skipped' ? `Week ${row.weekNumber}, skipped` : `Week ${row.weekNumber}${row.isCurrent ? ', current week' : ''}${row.opponentTeamName ? `, ${row.opponentTeamName}` : ''}, ${row.status === 'live' ? 'Live ' : ''}${result}`
                    const content = <>
                        <View style={styles.week}>
                            <Text style={[textStyles.tableCell, row.isCurrent && tableStyles.textMe]}>{row.weekNumber}</Text>
                            {row.isCurrent ? <Badge label="Now" size="small" variant="solid" color={colors.primary} /> : null}
                        </View>
                        <Text numberOfLines={1} style={[textStyles.rowTitle, styles.opponent, row.status === 'skipped' && styles.placeholder]}>{row.status === 'skipped' ? 'No matchup' : row.opponentTeamName ?? (row.status === 'playoffs' ? '—' : 'To be decided')}</Text>
                        {outcome ? (
                            <View style={styles.result}>
                                <Text style={[textStyles.tableHeader, styles.outcome, row.status === 'win' && styles.win, row.status === 'loss' && styles.loss, row.status === 'live' && styles.live]}>{outcome}</Text>
                                <Text style={[textStyles.stat, styles.score, row.status === 'win' && styles.win]}>{formatPoints(row.myPoints ?? 0)}</Text>
                                <Text style={[textStyles.stat, styles.score]}>{formatPoints(row.opponentPoints ?? 0)}</Text>
                            </View>
                        ) : <Text style={[textStyles.meta, styles.result, styles.status]}>{result}</Text>}
                    </>
                    return (
                        <View key={row.weekNumber} ref={row.isCurrent ? currentRow : undefined} role="listitem" aria-label={label} accessibilityLabel={label}
                            style={[styles.row, { paddingHorizontal: spacing.lg }, row.isCurrent && tableStyles.rowMe]}>
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
    action: { flex: 1, minHeight: controlSize.minTouch, flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
    week: { width: table.statColWidth + spacing.md, flexShrink: 0, alignItems: 'flex-start', gap: spacing.xs },
    opponent: { flex: 1, minWidth: 0 },
    placeholder: { color: colors.textMuted },
    result: { width: table.scoreColWidth * 3, flexShrink: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', textAlign: 'right' },
    outcome: { flex: 1, textAlign: 'left', color: colors.textSecondary },
    score: { width: table.scoreColWidth, textAlign: 'right' },
    status: { color: colors.textSecondary },
    win: { color: colors.success, fontWeight: fontWeight.bold },
    loss: { color: colors.danger },
    live: { color: colors.primaryDark },
})
