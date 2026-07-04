import { memo, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { LineupPlayer } from '@/lib/lineup'
import { LiveStatLine } from '@/lib/games'
import { computeLiveFantasyPoints } from '@/lib/scoring'
import { POSITION_COLORS } from '@/constants/positions'
import { colors, palette, fontWeight } from '@/constants/tokens'
import { PosTag } from '@/components/PosTag'
import { InjuryBadge } from '@/components/InjuryBadge'
import { shortName } from '@/lib/format'
import { LivePulse, MotionPressable, MotionView } from '@/components/Motion'

type Sel = { kind: 'starter' | 'bench' | 'ir' | 'taxi'; index: number }

const SLOT_W = 52

function emptySlotLabel(slotType: string): string {
    if (slotType === 'BE') return 'Empty bench slot'
    if (slotType === 'IR') return 'Empty IR slot'
    if (slotType === 'TX') return 'Empty taxi slot'
    return 'No starter'
}

function StatLines({ stats, isLive, align, compact = false }: {
    stats: LiveStatLine
    isLive: boolean
    align: 'left' | 'right'
    compact?: boolean
}) {
    const base = [styles.statLine, isLive ? styles.statLineLive : null, { textAlign: align }]
    if (stats.didNotPlay) return <Text style={base}>DNP</Text>
    const to = stats.turnovers ?? 0
    const line1 = [
        stats.points   ? `${stats.points} PTS`   : null,
        stats.rebounds ? `${stats.rebounds} REB`  : null,
        stats.assists  ? `${stats.assists} AST`   : null,
        stats.steals   ? `${stats.steals} STL`    : null,
        stats.blocks   ? `${stats.blocks} BLK`    : null,
    ].filter(Boolean).join(', ') || '—'
    const line2 = [
        stats.fgAttempted ? `${stats.fgMade}/${stats.fgAttempted} FGM` : null,
        stats.ftAttempted ? `${stats.ftMade}/${stats.ftAttempted} FTM` : null,
        stats.threeMade   ? `${stats.threeMade} 3PM`                   : null,
        to                ? `${to} TO`                                  : null,
        stats.fouls       ? `${stats.fouls} PF`                        : null,
    ].filter(Boolean).join(', ')
    return (
        <>
            <Text style={base} numberOfLines={1}>{line1}</Text>
            {!compact && line2 ? <Text style={base} numberOfLines={1}>{line2}</Text> : null}
        </>
    )
}

function ExpandedStats({ label, player, stats, fpts, isLive }: {
    label: string
    player: LineupPlayer | null
    stats?: LiveStatLine
    fpts: number | null
    isLive: boolean
}) {
    if (!player) {
        return (
            <View style={styles.expandedSide}>
                <Text style={styles.expandedLabel}>{label}</Text>
                <Text style={styles.expandedEmpty}>Empty slot</Text>
            </View>
        )
    }

    const items = stats
        ? [
              ['FP', fpts ?? '—'],
              ['PTS', stats.points ?? 0],
              ['REB', stats.rebounds ?? 0],
              ['AST', stats.assists ?? 0],
              ['STL', stats.steals ?? 0],
              ['BLK', stats.blocks ?? 0],
              ['3PM', stats.threeMade ?? 0],
              ['TO', stats.turnovers ?? 0],
          ]
        : [
              ['FP', '—'],
              ['PTS', '—'],
              ['REB', '—'],
              ['AST', '—'],
              ['STL', '—'],
              ['BLK', '—'],
              ['3PM', '—'],
              ['TO', '—'],
          ]

    return (
        <View style={styles.expandedSide}>
            <Text style={styles.expandedLabel}>{label}</Text>
            <View style={styles.expandedNameRow}>
                <Text style={styles.expandedName} numberOfLines={1}>{player.displayName}</Text>
                {isLive ? <LivePulse color={palette.green600} size={5} /> : null}
            </View>
            <View style={styles.expandedGrid}>
                {items.map(([statLabel, value]) => (
                    <View key={statLabel} style={styles.expandedStat}>
                        <Text style={styles.expandedStatValue}>{value}</Text>
                        <Text style={styles.expandedStatLabel}>{statLabel}</Text>
                    </View>
                ))}
            </View>
            {stats?.didNotPlay ? <Text style={styles.expandedNote}>Did not play</Text> : null}
        </View>
    )
}

type MatchupRowProps = {
    myPlayer: LineupPlayer | null
    oppPlayer: LineupPlayer | null
    slotType: string
    selKind: 'starter' | 'bench' | 'ir' | 'taxi'
    selIndex: number
    selected: Sel | null
    onTap: (sel: Sel) => void
    saving: boolean
    playingTeams: Set<string>
    liveStats: Map<string, LiveStatLine>
    liveTeams: Set<string>
    scoringSettings: Record<string, number>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    isExtraOppRow?: boolean
    compact?: boolean
    dense?: boolean
    motionDelay?: number
}

function MatchupRowImpl({
    myPlayer,
    oppPlayer,
    slotType,
    selKind,
    selIndex,
    selected,
    onTap,
    saving,
    playingTeams,
    liveStats,
    liveTeams,
    scoringSettings,
    teamMatchups,
    isExtraOppRow = false,
    compact = false,
    dense = false,
    motionDelay = 0,
}: MatchupRowProps) {
    const [expanded, setExpanded] = useState(false)
    const isSel = selected?.kind === selKind && selected.index === selIndex
    const slotColor = slotType === 'IR' ? colors.danger : slotType === 'TX' ? palette.gray500 : (POSITION_COLORS[slotType] ?? colors.textPlaceholder)
    const myHasGame = myPlayer?.nbaTeam ? playingTeams.has(myPlayer.nbaTeam) : false
    const oppHasGame = oppPlayer?.nbaTeam ? playingTeams.has(oppPlayer.nbaTeam) : false
    const myMatchup = myPlayer?.nbaTeam ? teamMatchups.get(myPlayer.nbaTeam) : undefined
    const oppMatchup = oppPlayer?.nbaTeam ? teamMatchups.get(oppPlayer.nbaTeam) : undefined
    const myMatchupLabel = myPlayer?.nbaTeam
        ? (myMatchup ? `${myMatchup.isHome ? 'vs' : '@'} ${myMatchup.opponent}` : '· No game')
        : null
    const oppMatchupLabel = oppPlayer?.nbaTeam
        ? (oppMatchup ? `${oppMatchup.isHome ? 'vs' : '@'} ${oppMatchup.opponent}` : '· No game')
        : null
    const myStats = myPlayer ? liveStats.get(myPlayer.playerId) : undefined
    const oppStats = oppPlayer ? liveStats.get(oppPlayer.playerId) : undefined
    const myIsLive = myPlayer?.nbaTeam ? liveTeams.has(myPlayer.nbaTeam) : false
    const oppIsLive = oppPlayer?.nbaTeam ? liveTeams.has(oppPlayer.nbaTeam) : false
    const myFpts = myStats && !myStats.didNotPlay ? computeLiveFantasyPoints(myStats, scoringSettings) : null
    const oppFpts = oppStats && !oppStats.didNotPlay ? computeLiveFantasyPoints(oppStats, scoringSettings) : null
    const myPlayedToday = myStats != null && !myStats.didNotPlay
    const oppPlayedToday = oppStats != null && !oppStats.didNotPlay
    const myShowInjury = myPlayer?.injuryStatus && !myPlayedToday
    const oppShowInjury = oppPlayer?.injuryStatus && !oppPlayedToday

    return (
        <MotionView style={styles.matchupRowWrap} preset="fade" delay={motionDelay}>
            <View
                style={[
                    styles.matchupRow,
                    compact && styles.matchupRowCompact,
                    dense && styles.matchupRowDense,
                    isExtraOppRow && styles.extraOppRow,
                ]}
            >
            {/* Left: my player (right-aligned) */}
            <MotionPressable
                style={styles.rowSideLeft}
                onPress={myPlayer || oppPlayer ? () => setExpanded((value) => !value) : undefined}
                disabled={!myPlayer}
                accessibilityRole="button"
                accessibilityLabel={myPlayer ? `Stat details for ${myPlayer.displayName}` : 'Toggle matchup stat details'}
                accessibilityState={{ expanded }}
                pressedScale={0.985}
            >
                {myPlayer ? (
                    <>
                        {myFpts != null && (
                            <Text style={[styles.fptsNum, dense && styles.fptsNumDense, myIsLive && styles.fptsLive]}>{myFpts}</Text>
                        )}
                        <View style={styles.playerBlockRight}>
                            <View style={[styles.metaRow, { justifyContent: 'flex-end' }]}>
                                {myShowInjury && <InjuryBadge status={myPlayer.injuryStatus} />}
                                <Text style={[styles.sideName, dense && styles.sideNameDense, !myHasGame && styles.noGameName]} numberOfLines={1}>
                                    {shortName(myPlayer.displayName)}
                                </Text>
                            </View>
                            {!dense && <View style={[styles.metaRow, { justifyContent: 'flex-end' }]}>
                                {myIsLive && (
                                    <View style={styles.liveBadgeRow}>
                                        <LivePulse color={palette.green600} size={5} />
                                        <Text style={styles.lockedBadge}>LIVE</Text>
                                    </View>
                                )}
                                {!compact && myPlayer.eligiblePositions.map((pos) => <PosTag key={pos} position={pos} />)}
                                {myMatchupLabel !== null && (
                                    <Text style={styles.sideMeta} numberOfLines={1}>
                                        {myPlayer.nbaTeam} {myMatchupLabel}
                                    </Text>
                                )}
                            </View>}
                            {myStats && !dense ? (
                                <StatLines stats={myStats} isLive={myIsLive} align="right" compact={compact} />
                            ) : null}
                        </View>
                    </>
                ) : isExtraOppRow ? null : (
                    <View style={styles.playerBlockRight}>
                        <Text style={styles.emptySlotText}>{emptySlotLabel(slotType)}</Text>
                    </View>
                )}
            </MotionPressable>

            {/* Center: slot chip */}
            <MotionPressable
                style={[
                    styles.slotChipCenter,
                    compact && styles.slotChipCenterCompact,
                    dense && styles.slotChipCenterDense,
                    { backgroundColor: slotColor + '22' },
                    isSel && styles.slotChipSelected,
                    saving && { opacity: 0.4 },
                ]}
                onPress={isExtraOppRow ? undefined : () => onTap({ kind: selKind, index: selIndex })}
                disabled={saving || isExtraOppRow}
                accessibilityRole="button"
                accessibilityLabel={myPlayer
                    ? `Select ${slotType} slot, ${myPlayer.displayName}`
                    : `Select empty ${slotType} slot ${selIndex + 1}`}
                accessibilityState={{ disabled: saving || isExtraOppRow, selected: isSel }}
                hitSlop={7}
                pressedScale={0.88}
            >
                <Text style={[styles.slotChipText, { color: isSel ? colors.primary : slotColor }]}>
                    {isExtraOppRow ? '—' : slotType}
                </Text>
            </MotionPressable>

            {/* Right: opponent player (left-aligned) */}
            <MotionPressable
                style={styles.rowSideRight}
                onPress={myPlayer || oppPlayer ? () => setExpanded((value) => !value) : undefined}
                disabled={!oppPlayer}
                accessibilityRole="button"
                accessibilityLabel={oppPlayer ? `Stat details for ${oppPlayer.displayName}` : 'Toggle matchup stat details'}
                accessibilityState={{ expanded }}
                pressedScale={0.985}
            >
                {oppPlayer ? (
                    <>
                        <View style={styles.playerBlockLeft}>
                            <View style={styles.metaRow}>
                                <Text style={[styles.sideName, dense && styles.sideNameDense, !oppHasGame && styles.noGameName]} numberOfLines={1}>
                                    {shortName(oppPlayer.displayName)}
                                </Text>
                                {oppShowInjury && <InjuryBadge status={oppPlayer.injuryStatus} />}
                            </View>
                            {!dense && <View style={styles.metaRow}>
                                {!compact && oppPlayer.eligiblePositions.map((pos) => <PosTag key={pos} position={pos} />)}
                                {oppMatchupLabel !== null && (
                                    <Text style={styles.sideMeta} numberOfLines={1}>
                                        {oppPlayer.nbaTeam} {oppMatchupLabel}
                                    </Text>
                                )}
                                {oppIsLive && (
                                    <View style={styles.liveBadgeRow}>
                                        <LivePulse color={palette.green600} size={5} />
                                        <Text style={styles.lockedBadge}>LIVE</Text>
                                    </View>
                                )}
                            </View>}
                            {oppStats && !dense ? (
                                <StatLines stats={oppStats} isLive={oppIsLive} align="left" compact={compact} />
                            ) : null}
                        </View>
                        {oppFpts != null && (
                            <Text style={[styles.fptsNum, styles.fptsRight, dense && styles.fptsNumDense, oppIsLive && styles.fptsLive]}>{oppFpts}</Text>
                        )}
                    </>
                ) : (
                    <View style={styles.playerBlockLeft}>
                        <Text style={styles.emptySlotText}>{emptySlotLabel(slotType)}</Text>
                    </View>
                )}
            </MotionPressable>
            </View>
            {expanded ? (
                <View style={styles.expandedPanel}>
                    <ExpandedStats label="You" player={myPlayer} stats={myStats} fpts={myFpts} isLive={myIsLive} />
                    <View style={styles.expandedDivider} />
                    <ExpandedStats label="Opponent" player={oppPlayer} stats={oppStats} fpts={oppFpts} isLive={oppIsLive} />
                </View>
            ) : null}
        </MotionView>
    )
}

export const MatchupRow = memo(MatchupRowImpl)

const styles = StyleSheet.create({
    matchupRowWrap: {
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    matchupRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        gap: 8,
    },
    matchupRowCompact: {
        paddingVertical: 4,
        gap: 6,
    },
    matchupRowDense: {
        paddingVertical: 2,
    },
    extraOppRow: {
    },
    rowSideLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
    rowSideRight: { flex: 1, flexDirection: 'row', alignItems: 'center' },
    playerBlockRight: { flex: 1, alignItems: 'flex-end' },
    playerBlockLeft: { flex: 1, alignItems: 'flex-start' },
    fptsNum: { fontSize: 20, fontWeight: '800', color: colors.textMuted, minWidth: 36, textAlign: 'left', marginRight: 6 },
    fptsNumDense: { fontSize: 16, minWidth: 28 },
    fptsRight: { textAlign: 'right', marginRight: 0, marginLeft: 6 },
    fptsLive: { color: colors.primaryDark },
    sideName: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },
    emptySlotText: { fontSize: 12, fontWeight: '500', color: colors.textPlaceholder },
    sideNameDense: { fontSize: 12 },
    noGameName: { color: palette.gray500 },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
    sideMeta: { fontSize: 11, color: colors.textPlaceholder },
    lockedBadge: { fontSize: 10, fontWeight: fontWeight.bold, color: palette.green600, letterSpacing: 0.4, marginHorizontal: 3 },
    liveBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    statLine: { fontSize: 11, color: colors.textMuted, textAlign: 'right', marginTop: 1 },
    statLineLive: { color: colors.primaryDark, fontWeight: fontWeight.semibold },
    slotChipCenter: {
        width: SLOT_W,
        height: 30,
        borderRadius: 8,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    slotChipCenterCompact: {
        width: 42,
        height: 26,
        borderRadius: 7,
    },
    slotChipCenterDense: {
        width: 38,
        height: 24,
    },
    slotChipSelected: { borderWidth: 1.5, borderColor: colors.primary },
    slotChipText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
    expandedPanel: {
        flexDirection: 'row',
        gap: 10,
        paddingHorizontal: 8,
        paddingTop: 2,
        paddingBottom: 10,
        backgroundColor: colors.bgSubtle,
    },
    expandedSide: {
        flex: 1,
        minWidth: 0,
        gap: 5,
    },
    expandedDivider: {
        width: 1,
        backgroundColor: colors.borderLight,
    },
    expandedLabel: {
        fontSize: 10,
        fontWeight: fontWeight.extrabold,
        color: colors.textPlaceholder,
        letterSpacing: 0.8,
        textTransform: 'uppercase' as const,
    },
    expandedNameRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    expandedName: {
        flex: 1,
        fontSize: 12,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },
    expandedGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 5,
    },
    expandedStat: {
        width: 42,
        paddingVertical: 5,
        borderRadius: 7,
        backgroundColor: colors.bgCard,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: colors.borderLight,
    },
    expandedStatValue: {
        fontSize: 12,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    expandedStatLabel: {
        fontSize: 9,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
    },
    expandedEmpty: {
        fontSize: 12,
        color: colors.textPlaceholder,
    },
    expandedNote: {
        fontSize: 11,
        fontWeight: fontWeight.semibold,
        color: colors.textMuted,
    },
})
