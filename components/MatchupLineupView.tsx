import { useMemo, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { SectionBand } from '@/components/ui/SectionBand'
import { MatchupColumnHeader, MatchupRow, type MatchupGame } from '@/components/MatchupRow'
import type { LineupPlayer, LineupMoveData } from '@/lib/lineup'
import type { LiveStatLine } from '@/lib/games'
import type { StatColumn } from '@/lib/score-breakdown'
import { formatPoints } from '@/lib/format'
import { matchupDailyTotal } from '@/lib/matchup-daily-total'
import { borderWidth, colors, fontSize, fontWeight, radii, spacing, srOnly, textStyles } from '@/constants/tokens'

type DetailsRow = { myPlayer: LineupPlayer | null; oppPlayer: LineupPlayer | null; slotType: string }

// The section bands and AUTO control label the lineup on screen; this heading
// keeps the page outline intact for screen readers.
function LineupHeading() {
    return (
        <Text style={srOnly} role="heading" aria-level={2} accessibilityRole="header">
            Lineup
        </Text>
    )
}

export function MatchupLineupView({
    myLineup,
    oppLineup,
    playingTeams,
    liveStats,
    liveTeams,
    scoringSettings,
    teamMatchups,
    timezone,
    statColumns,
    onOpenDetails,
    onOpenPlayer,
    capacity,
    compact,
    dense,
    daySelector,
    footer,
    hideSlotCounts = false,
}: {
    myLineup: Required<LineupMoveData>
    oppLineup: Required<LineupMoveData>
    playingTeams: Set<string>
    liveStats: Map<string, LiveStatLine>
    liveTeams: Set<string>
    scoringSettings: Record<string, number>
    teamMatchups: Map<string, MatchupGame>
    timezone?: string
    statColumns: StatColumn[] | null
    onOpenDetails: (row: DetailsRow) => void
    onOpenPlayer: (player: LineupPlayer) => void
    /** League slot counts; every slot shows, filled or empty, so open room is visible. */
    capacity: { bench: number; ir: number; taxi: number }
    compact: boolean
    dense: boolean
    daySelector?: ReactNode
    hideSlotCounts?: boolean
    footer?: ReactNode
}) {
    const noStarters = !myLineup.starters.some((slot) => slot.player) && !oppLineup.starters.some((slot) => slot.player)
    const maxBench = Math.max(myLineup.bench.length, oppLineup.bench.length, capacity.bench)
    const maxIR = Math.max(myLineup.ir.length, oppLineup.ir.length, capacity.ir)
    const maxTaxi = Math.max(myLineup.taxi.length, oppLineup.taxi.length, capacity.taxi)
    const sections = useMemo(
        () => [
            {
                key: 'starters' as const,
                label: 'Starters',
                count: myLineup.starters.length,
                used: `${myLineup.starters.filter((slot) => slot.player).length}/${myLineup.starters.length}`,
                color: colors.primaryDark,
                rows: myLineup.starters.map((slot, i) => ({
                    key: `s${i}`,
                    myPlayer: slot.player,
                    oppPlayer: oppLineup.starters[i]?.player ?? null,
                    slotType: slot.slotType,
                    slotIndex: i,
                    isExtraOppRow: false,
                })),
            },
            {
                key: 'bench' as const,
                label: 'Bench',
                count: maxBench,
                used: myLineup.starters.some(slot => slot.player) && myLineup.bench.length <= capacity.bench
                    ? `${myLineup.bench.length}/${capacity.bench}` : null,
                color: colors.textMuted,
                rows: Array.from({ length: maxBench }, (_, i) => ({
                    key: `b${i}`,
                    myPlayer: myLineup.bench[i] ?? null,
                    oppPlayer: oppLineup.bench[i] ?? null,
                    slotType: 'BE',
                    slotIndex: i,
                    // Rows past my bench size still show my empty side; only rows past
                    // the league's bench size belong to the opponent alone.
                    isExtraOppRow: i >= Math.max(myLineup.bench.length, capacity.bench),
                })),
            },
            {
                key: 'ir' as const,
                label: 'Injured Reserve',
                count: maxIR,
                used: `${myLineup.ir.length}/${capacity.ir}`,
                color: colors.danger,
                rows: Array.from({ length: maxIR }, (_, i) => ({
                    key: `ir${i}`,
                    myPlayer: myLineup.ir[i] ?? null,
                    oppPlayer: oppLineup.ir[i] ?? null,
                    slotType: 'IR',
                    slotIndex: i,
                    isExtraOppRow: false,
                })),
            },
            {
                key: 'taxi' as const,
                label: 'Taxi Squad',
                count: maxTaxi,
                used: `${myLineup.taxi.length}/${capacity.taxi}`,
                color: colors.textMuted,
                rows: Array.from({ length: maxTaxi }, (_, i) => ({
                    key: `tx${i}`,
                    myPlayer: myLineup.taxi[i] ?? null,
                    oppPlayer: oppLineup.taxi[i] ?? null,
                    slotType: 'TX',
                    slotIndex: i,
                    isExtraOppRow: false,
                })),
            },
        ].filter((section) => section.count > 0),
        [capacity.bench, capacity.ir, capacity.taxi, maxBench, maxIR, maxTaxi, myLineup, oppLineup],
    )

    return (
        <View style={styles.lineupContainer}>
            <LineupHeading />
            {daySelector}

            <View style={styles.lineupRowsContent}>
                {sections.map((section) => (
                    <View key={section.key} style={styles.lineupSection}>
                        {/* Slot counts describe your own lineup; another team's matchup is view-only, so they are hidden. */}
                        <SectionBand label={section.label}
                            variant="matchup"
                            labelStyle={{ color: section.color }}
                            detail={section.used !== null && !hideSlotCounts ? <Text style={styles.lineupSectionCount}>{section.used}</Text> : undefined}
                        />
                        {section.key === 'starters' && noStarters ? (
                            <Text style={styles.noStarters} accessibilityLabel="No lineups set this day">No lineups set this day</Text>
                        ) : (
                            <>
                                {statColumns ? <MatchupColumnHeader columns={statColumns} /> : null}
                                {section.rows.map((row, i) => (
                                    <MatchupRow
                                        key={row.key}
                                        myPlayer={row.myPlayer}
                                        oppPlayer={row.oppPlayer}
                                        slotType={row.slotType}
                                        slotIndex={row.slotIndex}
                                        playingTeams={playingTeams}
                                        liveStats={liveStats}
                                        liveTeams={liveTeams}
                                        scoringSettings={scoringSettings}
                                        teamMatchups={teamMatchups}
                                        timezone={timezone}
                                        isExtraOppRow={row.isExtraOppRow}
                                        compact={compact}
                                        dense={dense}
                                        motionDelay={i * 18}
                                        statColumns={statColumns}
                                        onOpenDetails={onOpenDetails}
                                        onOpenPlayer={onOpenPlayer}
                                    />
                                ))}
                            </>
                        )}
                        {section.key === 'starters' ? (
                            <View testID="matchup-daily-total" style={styles.dailyTotal}>
                                <Text testID="matchup-daily-total-left" style={styles.dailyTotalScore}>
                                    {formatPoints(matchupDailyTotal(myLineup.starters, liveStats, scoringSettings) ?? 0)}
                                </Text>
                                <Text style={styles.dailyTotalLabel}>Daily Total</Text>
                                <Text testID="matchup-daily-total-right" style={styles.dailyTotalScore}>
                                    {formatPoints(matchupDailyTotal(oppLineup.starters, liveStats, scoringSettings) ?? 0)}
                                </Text>
                            </View>
                        ) : null}
                    </View>
                ))}
                {footer ? <View style={styles.lineupFooter}>{footer}</View> : null}
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    lineupContainer: { width: '100%' },
    lineupRowsContent: { paddingTop: spacing.xxs, paddingBottom: spacing.md },
    lineupSection: {
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgCard,
        overflow: 'hidden' as const,
        marginBottom: spacing.md,
    },
    lineupSectionCount: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
    },
    dailyTotal: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.lg,
        backgroundColor: colors.bgSubtle,
        borderTopColor: colors.separator,
        borderTopWidth: borderWidth.thin,
        borderBottomColor: colors.separator,
        borderBottomWidth: borderWidth.thin,
    },
    dailyTotalScore: {
        ...textStyles.compactScore,
        flex: 1,
        textAlign: 'center',
        color: colors.textPrimary,
    },
    dailyTotalLabel: {
        ...textStyles.rowTitle,
        color: colors.textSecondary,
        marginHorizontal: spacing.md,
    },
    lineupFooter: {
        gap: spacing.md,
        paddingTop: spacing.xs,
        paddingBottom: spacing.lg,
    },
    noStarters: { ...textStyles.meta, padding: spacing.lg },
})
