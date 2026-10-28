import { useMemo, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { SectionBand } from '@/components/ui/SectionBand'
import { MatchupColumnHeader, MatchupRow } from '@/components/MatchupRow'
import type { MatchupForecast } from '@/hooks/use-matchup-forecast'
import type { LineupPlayer, LineupMoveData, LineupSelection, LineupMoveTargetState } from '@/lib/lineup'
import type { LiveStatLine } from '@/lib/games'
import type { StatColumn } from '@/lib/score-breakdown'
import { colors, fontSize, fontWeight, radii, spacing, srOnly, textStyles } from '@/constants/tokens'

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
    playerForecasts, forecastStale, myMemberId, opponentMemberId,
    myLineup,
    oppLineup,
    selected,
    getTargetState,
    onTap,
    saving,
    playingTeams,
    liveStats,
    liveTeams,
    scoringSettings,
    teamMatchups,
    statColumns,
    onOpenDetails,
    onOpenPlayer,
    capacity,
    compact,
    dense,
    daySelector,
    autoSetControl,
    footer,
}: {
    playerForecasts: Map<string, MatchupForecast['games'][number]>
    forecastStale: boolean
    myMemberId: string
    opponentMemberId: string
    myLineup: Required<LineupMoveData>
    oppLineup: Required<LineupMoveData>
    selected: LineupSelection | null
    getTargetState: (selection: LineupSelection) => LineupMoveTargetState
    onTap: (sel: LineupSelection) => void
    saving: boolean
    playingTeams: Set<string>
    liveStats: Map<string, LiveStatLine>
    liveTeams: Set<string>
    scoringSettings: Record<string, number>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    statColumns: StatColumn[] | null
    onOpenDetails: (row: DetailsRow) => void
    onOpenPlayer: (player: LineupPlayer) => void
    /** League slot counts; every slot shows, filled or empty, so open room is visible. */
    capacity: { bench: number; ir: number; taxi: number }
    compact: boolean
    dense: boolean
    daySelector?: ReactNode
    autoSetControl?: ReactNode
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
                    selKind: 'starter' as const,
                    selIndex: i,
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
                    selKind: 'bench' as const,
                    selIndex: i,
                    // Rows past my bench size are open slots I can move a starter into;
                    // only rows past the league's bench size belong to the opponent alone.
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
                    selKind: 'ir' as const,
                    selIndex: i,
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
                    selKind: 'taxi' as const,
                    selIndex: i,
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
                        <SectionBand label={section.label}
                            variant={section.key === 'starters' && autoSetControl ? 'action' : 'matchup'}
                            labelStyle={{ color: section.color }}
                            detail={section.key === 'starters' && autoSetControl ? autoSetControl : section.used !== null ? <Text style={styles.lineupSectionCount}>{section.used}</Text> : undefined}
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
                                        myProjection={row.myPlayer ? playerForecasts.get(`${myMemberId}:${row.myPlayer.playerId}`) : undefined}
                                        oppProjection={row.oppPlayer ? playerForecasts.get(`${opponentMemberId}:${row.oppPlayer.playerId}`) : undefined}
                                        forecastStale={forecastStale}
                                        showProjections
                                        oppPlayer={row.oppPlayer}
                                        slotType={row.slotType}
                                        selKind={row.selKind}
                                        selIndex={row.selIndex}
                                        isSelected={selected?.kind === row.selKind && selected.index === row.selIndex}
                                        onTap={onTap}
                                        saving={saving}
                                        playingTeams={playingTeams}
                                        liveStats={liveStats}
                                        liveTeams={liveTeams}
                                        scoringSettings={scoringSettings}
                                        teamMatchups={teamMatchups}
                                        isExtraOppRow={row.isExtraOppRow}
                                        compact={compact}
                                        dense={dense}
                                        motionDelay={i * 18}
                                        targetState={getTargetState({ kind: row.selKind, index: row.selIndex })}
                                        statColumns={statColumns}
                                        onOpenDetails={onOpenDetails}
                                        onOpenPlayer={onOpenPlayer}
                                    />
                                ))}
                            </>
                        )}
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
    lineupFooter: {
        gap: spacing.md,
        paddingTop: spacing.xs,
        paddingBottom: spacing.lg,
    },
    noStarters: { ...textStyles.meta, padding: spacing.lg },
})
