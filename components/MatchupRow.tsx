import { memo, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { LineupPlayer } from '@/lib/lineup'
import { LiveStatLine } from '@/lib/games'
import { computeLiveFantasyPoints } from '@/lib/scoring'
import { POSITION_COLORS } from '@/constants/positions'
import { alpha, colors, fontSize, fontWeight, INJURY_COLORS, spacing, uiColors } from '@/constants/tokens'
import { PosTag } from '@/components/PosTag'
import { Badge } from '@/components/Badge'
import { formatPoints, playerHeadshotUrl, shortName } from '@/lib/format'
import { LivePulse, MotionPressable, MotionView } from '@/components/Motion'
import { Avatar } from '@/components/Avatar'

type Sel = { kind: 'starter' | 'bench' | 'ir' | 'taxi'; index: number }

const SLOT_W = 52
const STABLE_PLACEHOLDER = '—'

function emptySlotLabel(slotType: string): string {
    if (slotType === 'BE') return 'Empty bench slot'
    if (slotType === 'IR') return 'Empty IR slot'
    if (slotType === 'TX') return 'Empty taxi slot'
    return 'No starter'
}

function LineupAvatar({ player, compact = false, dense = false }: { player: LineupPlayer; compact?: boolean; dense?: boolean }) {
    const size = dense ? 24 : compact ? 28 : 30
    return (
        <View style={[styles.lineupAvatarFrame, { width: size + 2, height: size + 2, borderRadius: (size + 2) / 2 }]}>
            <Avatar
                name={player.displayName}
                uri={playerHeadshotUrl(player.nbaId) ?? undefined}
                color={POSITION_COLORS[player.position ?? ''] ?? colors.bgMuted}
                textColor={colors.textSecondary}
                size={size}
            />
        </View>
    )
}

function StatLines({ stats, isLive, align, compact = false }: {
    stats?: LiveStatLine
    isLive: boolean
    align: 'left' | 'right'
    compact?: boolean
}) {
    const base = [styles.statLine, isLive ? styles.statLineLive : null, { textAlign: align }]
    let line1 = STABLE_PLACEHOLDER
    let line2 = STABLE_PLACEHOLDER
    if (stats?.didNotPlay) {
        line1 = 'DNP'
    } else if (stats) {
        const to = stats.turnovers ?? 0
        line1 = [
            stats.points   ? `${stats.points} PTS`   : null,
            stats.rebounds ? `${stats.rebounds} REB`  : null,
            stats.assists  ? `${stats.assists} AST`   : null,
            stats.steals   ? `${stats.steals} STL`    : null,
            stats.blocks   ? `${stats.blocks} BLK`    : null,
            stats.threeMade ? `${stats.threeMade} 3PM` : null,
            to             ? `${to} TO`                : null,
        ].filter(Boolean).join(', ') || STABLE_PLACEHOLDER
        line2 = [
            stats.fgAttempted ? `${stats.fgMade}/${stats.fgAttempted} FGM` : null,
            stats.ftAttempted ? `${stats.ftMade}/${stats.ftAttempted} FTM` : null,
            stats.fouls       ? `${stats.fouls} PF`                        : null,
        ].filter(Boolean).join(', ') || STABLE_PLACEHOLDER
    }
    return (
        <View style={[styles.statStack, compact && styles.statStackCompact]}>
            <Text style={base} numberOfLines={1}>{line1}</Text>
            {!compact ? <Text style={base} numberOfLines={1}>{line2}</Text> : null}
        </View>
    )
}

function FantasyScore({
    value,
    isLive,
    side,
    dense = false,
}: {
    value: number | null
    isLive: boolean
    side: 'left' | 'right'
    dense?: boolean
}) {
    const displayValue = formatPoints(value)
    return (
        <Text
            style={[
                styles.fptsNum,
                side === 'right' && styles.fptsRight,
                dense && styles.fptsNumDense,
                value == null && styles.fptsPlaceholder,
                value != null && isLive && styles.fptsLive,
            ]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.72}
            ellipsizeMode="clip"
        >
            {displayValue}
        </Text>
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
              ['MIN', stats.minutesPlayed ?? 0],
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
              ['MIN', '—'],
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
                <LineupAvatar player={player} dense />
                <Text style={styles.expandedName} numberOfLines={1}>{player.displayName}</Text>
                {isLive ? <LivePulse color={uiColors.successTextLive} size={5} /> : null}
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
    const slotColor = slotType === 'IR'
        ? uiColors.accentDanger
        : slotType === 'TX'
            ? uiColors.neutralTint
            : (POSITION_COLORS[slotType] ?? uiColors.neutralTint)
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
                        <FantasyScore value={myFpts} isLive={myIsLive} side="left" dense={dense} />
                        <View style={[styles.playerBlockRight, compact && styles.playerBlockCompact, dense && styles.playerBlockDense]}>
                            <View style={[styles.metaRow, styles.primaryMetaRow, { justifyContent: 'flex-end' }]}>
                                {myPlayer.injuryStatus && !myPlayedToday ? (
                                    <Badge
                                        label={myPlayer.injuryStatus}
                                        color={INJURY_COLORS[myPlayer.injuryStatus] ?? colors.textMuted}
                                        variant="solid"
                                    />
                                ) : null}
                                <Text style={[styles.sideName, dense && styles.sideNameDense, !myHasGame && styles.noGameName]} numberOfLines={1}>
                                    {shortName(myPlayer.displayName)}
                                </Text>
                                <LineupAvatar player={myPlayer} compact={compact} dense={dense} />
                            </View>
                            {!dense && <View style={[styles.metaRow, styles.secondaryMetaRow, { justifyContent: 'flex-end' }]}>
                                {myIsLive && (
                                    <View style={styles.liveBadgeRow}>
                                        <LivePulse color={uiColors.successTextLive} size={5} />
                                        <Text style={styles.lockedBadge}>LIVE</Text>
                                    </View>
                                )}
                                {!compact && myPlayer.eligiblePositions.map((pos) => <PosTag key={pos} position={pos} />)}
                                <Text style={styles.sideMeta} numberOfLines={1}>
                                    {myMatchupLabel !== null ? `${myPlayer.nbaTeam} ${myMatchupLabel}` : STABLE_PLACEHOLDER}
                                </Text>
                            </View>}
                            {!dense ? (
                                <StatLines stats={myStats} isLive={myIsLive} align="right" compact={compact} />
                            ) : null}
                        </View>
                    </>
                ) : isExtraOppRow ? null : (
                    <>
                        <FantasyScore value={null} isLive={false} side="left" dense={dense} />
                        <View style={[styles.playerBlockRight, compact && styles.playerBlockCompact, dense && styles.playerBlockDense]}>
                            <View style={[styles.metaRow, styles.primaryMetaRow, { justifyContent: 'flex-end' }]}>
                                <Text style={styles.emptySlotText} numberOfLines={1}>{emptySlotLabel(slotType)}</Text>
                            </View>
                            {!dense ? (
                                <>
                                    <View style={[styles.metaRow, styles.secondaryMetaRow, { justifyContent: 'flex-end' }]}>
                                        <Text style={styles.sideMeta} numberOfLines={1}>{STABLE_PLACEHOLDER}</Text>
                                    </View>
                                    <StatLines isLive={false} align="right" compact={compact} />
                                </>
                            ) : null}
                        </View>
                    </>
                )}
                {isExtraOppRow && !myPlayer ? (
                    <>
                        <FantasyScore value={null} isLive={false} side="left" dense={dense} />
                        <View style={[styles.playerBlockRight, compact && styles.playerBlockCompact, dense && styles.playerBlockDense]}>
                            <View style={[styles.metaRow, styles.primaryMetaRow, { justifyContent: 'flex-end' }]}>
                                <Text style={styles.sideMeta} numberOfLines={1}>{STABLE_PLACEHOLDER}</Text>
                            </View>
                            {!dense ? (
                                <>
                                    <View style={[styles.metaRow, styles.secondaryMetaRow, { justifyContent: 'flex-end' }]}>
                                        <Text style={styles.sideMeta} numberOfLines={1}>{STABLE_PLACEHOLDER}</Text>
                                    </View>
                                    <StatLines isLive={false} align="right" compact={compact} />
                                </>
                            ) : null}
                        </View>
                    </>
                ) : null}
            </MotionPressable>

            {/* Center: slot chip */}
            <MotionPressable
                style={[
                    styles.slotChipCenter,
                    compact && styles.slotChipCenterCompact,
                    dense && styles.slotChipCenterDense,
                    { backgroundColor: alpha(slotColor, 0.13) },
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
                        <View style={[styles.playerBlockLeft, compact && styles.playerBlockCompact, dense && styles.playerBlockDense]}>
                            <View style={[styles.metaRow, styles.primaryMetaRow]}>
                                <LineupAvatar player={oppPlayer} compact={compact} dense={dense} />
                                <Text style={[styles.sideName, dense && styles.sideNameDense, !oppHasGame && styles.noGameName]} numberOfLines={1}>
                                    {shortName(oppPlayer.displayName)}
                                </Text>
                                {oppPlayer.injuryStatus && !oppPlayedToday ? (
                                    <Badge
                                        label={oppPlayer.injuryStatus}
                                        color={INJURY_COLORS[oppPlayer.injuryStatus] ?? colors.textMuted}
                                        variant="solid"
                                    />
                                ) : null}
                            </View>
                            {!dense && <View style={[styles.metaRow, styles.secondaryMetaRow]}>
                                {!compact && oppPlayer.eligiblePositions.map((pos) => <PosTag key={pos} position={pos} />)}
                                <Text style={styles.sideMeta} numberOfLines={1}>
                                    {oppMatchupLabel !== null ? `${oppPlayer.nbaTeam} ${oppMatchupLabel}` : STABLE_PLACEHOLDER}
                                </Text>
                                {oppIsLive && (
                                    <View style={styles.liveBadgeRow}>
                                        <LivePulse color={uiColors.successTextLive} size={5} />
                                        <Text style={styles.lockedBadge}>LIVE</Text>
                                    </View>
                                )}
                            </View>}
                            {!dense ? (
                                <StatLines stats={oppStats} isLive={oppIsLive} align="left" compact={compact} />
                            ) : null}
                        </View>
                        <FantasyScore value={oppFpts} isLive={oppIsLive} side="right" dense={dense} />
                    </>
                ) : (
                    <>
                        <View style={[styles.playerBlockLeft, compact && styles.playerBlockCompact, dense && styles.playerBlockDense]}>
                            <View style={[styles.metaRow, styles.primaryMetaRow]}>
                                <Text style={styles.emptySlotText} numberOfLines={1}>{emptySlotLabel(slotType)}</Text>
                            </View>
                            {!dense ? (
                                <>
                                    <View style={[styles.metaRow, styles.secondaryMetaRow]}>
                                        <Text style={styles.sideMeta} numberOfLines={1}>{STABLE_PLACEHOLDER}</Text>
                                    </View>
                                    <StatLines isLive={false} align="left" compact={compact} />
                                </>
                            ) : null}
                        </View>
                        <FantasyScore value={null} isLive={false} side="right" dense={dense} />
                    </>
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
    lineupAvatarFrame: {
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        flexShrink: 0,
    },
    rowSideLeft: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', paddingLeft: spacing.sm },
    rowSideRight: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', paddingRight: spacing.sm },
    playerBlockRight: { flex: 1, minWidth: 0, minHeight: 66, justifyContent: 'center', alignItems: 'flex-end' },
    playerBlockLeft: { flex: 1, minWidth: 0, minHeight: 66, justifyContent: 'center', alignItems: 'flex-start' },
    playerBlockCompact: { minHeight: 48 },
    playerBlockDense: { minHeight: 28 },
    fptsNum: {
        fontSize: fontSize.xl,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        width: 64,
        flexShrink: 0,
        textAlign: 'left',
        marginRight: 6,
        fontVariant: ['tabular-nums'] as const,
    },
    fptsNumDense: { width: 54, fontSize: fontSize.lg },
    fptsRight: { textAlign: 'right', marginRight: spacing.sm, marginLeft: 6 },
    fptsPlaceholder: { color: colors.textPlaceholder },
    fptsLive: { color: colors.primaryDark },
    sideName: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textPrimary, flexShrink: 1 },
    emptySlotText: { fontSize: fontSize['2sm'], fontWeight: fontWeight.medium, color: colors.textPlaceholder },
    sideNameDense: { fontSize: fontSize['2sm'] },
    noGameName: { color: colors.textDisabled },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
    primaryMetaRow: { minHeight: 34, maxWidth: '100%' },
    secondaryMetaRow: { minHeight: 18, maxWidth: '100%' },
    sideMeta: { fontSize: fontSize.xs, color: colors.textPlaceholder },
    lockedBadge: { fontSize: fontSize['2xs'], fontWeight: fontWeight.bold, color: uiColors.successTextLive, letterSpacing: 0.4, marginHorizontal: 3 },
    liveBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    statStack: { minHeight: 32, justifyContent: 'center', alignSelf: 'stretch' },
    statStackCompact: { minHeight: 16 },
    statLine: { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'right', marginTop: 1 },
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
    slotChipText: { fontSize: fontSize.xs, fontWeight: fontWeight.extrabold, letterSpacing: 0.3 },
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
        fontSize: fontSize['2xs'],
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
        fontSize: fontSize['2sm'],
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
        fontSize: fontSize['2sm'],
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    expandedStatLabel: {
        fontSize: 9,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
    },
    expandedEmpty: {
        fontSize: fontSize['2sm'],
        color: colors.textPlaceholder,
    },
    expandedNote: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.semibold,
        color: colors.textMuted,
    },
})
