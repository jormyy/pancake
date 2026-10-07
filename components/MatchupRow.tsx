import { memo, useState, type ReactNode } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { LineupPlayer, type LineupMoveTargetState } from '@/lib/lineup'
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

function compactLineupName(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean)
    const last = parts.at(-1) ?? name
    const primary = last.split('-')[0]
    return primary.length > 6 ? primary.slice(0, 6) : primary
}

function matchupLine(
    team: string | null | undefined,
    matchup: { opponent: string; isHome: boolean } | undefined,
    compact: boolean,
    compactWithBadge = false,
): string {
    if (!team) return STABLE_PLACEHOLDER
    if (compactWithBadge) return team
    if (!matchup) return compact ? `${team} OFF` : `${team} · No game`
    return compact
        ? `${team}${matchup.isHome ? ' v ' : ' @ '}${matchup.opponent}`
        : `${team} ${matchup.isHome ? 'vs' : '@'} ${matchup.opponent}`
}

function LineupAvatar({ player, compact = false, dense = false }: { player: LineupPlayer; compact?: boolean; dense?: boolean }) {
    const size = dense || compact ? 24 : 28
    return (
        <View style={[styles.lineupAvatarFrame, { width: size + 2, height: size + 2, borderRadius: (size + 2) / 2 }]}>
            <Avatar
                name={player.displayName}
                uri={playerHeadshotUrl(player.nbaId) ?? undefined}
                color={colors.bgMuted}
                textColor={colors.textSecondary}
                size={size}
            />
        </View>
    )
}

function statParts(stats: LiveStatLine): string[] {
    return [
        stats.points   ? `${stats.points} PTS`   : null,
        stats.rebounds ? `${stats.rebounds} REB`  : null,
        stats.assists  ? `${stats.assists} AST`   : null,
        stats.steals   ? `${stats.steals} STL`    : null,
        stats.blocks   ? `${stats.blocks} BLK`    : null,
        stats.threeMade ? `${stats.threeMade} 3PM` : null,
        (stats.turnovers ?? 0) ? `${stats.turnovers ?? 0} TO` : null,
    ].filter((part): part is string => part != null)
}

// One line under the name: the NBA game before tip-off, the box score after.
// It is always present, so rows keep their height when live stats arrive.
function detailLine(
    team: string | null | undefined,
    matchup: { opponent: string; isHome: boolean } | undefined,
    stats: LiveStatLine | undefined,
    compact: boolean,
    compactWithBadge: boolean,
): string {
    const game = matchupLine(team, matchup, compact, compactWithBadge)
    if (stats?.didNotPlay) return compact ? 'DNP' : `${game} · DNP`
    const parts = stats ? statParts(stats) : []
    if (parts.length === 0) return game
    return compact ? parts.slice(0, 2).join(' ') : `${game} · ${parts.join(', ')}`
}

function InjuryStatusBadge({ status }: { status: string | null }) {
    if (!status) return null
    return (
        <Badge
            label={status}
            color={INJURY_COLORS[status] ?? colors.textMuted}
            variant="solid"
        />
    )
}

function LiveTag() {
    return (
        <View style={styles.liveBadgeRow}>
            <LivePulse color={uiColors.successTextLive} size={5} />
            <Text style={styles.lockedBadge}>LIVE</Text>
        </View>
    )
}

function FantasyScore({
    value,
    isLive,
    side,
    compact = false,
    dense = false,
}: {
    value: number | null
    isLive: boolean
    side: 'left' | 'right'
    compact?: boolean
    dense?: boolean
}) {
    const displayValue = formatPoints(value)
    return (
        <Text
            style={[
                styles.fptsNum,
                compact && styles.fptsNumCompact,
                dense && styles.fptsNumDense,
                side === 'right' && styles.fptsRight,
                side === 'left' && compact && styles.fptsLeftCompact,
                side === 'right' && compact && styles.fptsRightCompact,
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

function shootingLine(made: number | undefined, attempted: number | undefined): string {
    return attempted ? `${made ?? 0}/${attempted}` : '—'
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
              ['FG', shootingLine(stats.fgMade, stats.fgAttempted)],
              ['FT', shootingLine(stats.ftMade, stats.ftAttempted)],
          ]
        : ['FP', 'MIN', 'PTS', 'REB', 'AST', 'STL', 'BLK', '3PM', 'TO', 'FG', 'FT'].map((statLabel) => [statLabel, '—'])

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

// One half of a head-to-head row. The left half (mine) mirrors the right half
// (opponent) so both names sit next to the slot chip and points sit outside.
function PlayerSide({
    side,
    player,
    slotType,
    placeholderOnly,
    hasGame,
    isLive,
    stats,
    fpts,
    matchup,
    compact,
    dense,
}: {
    side: 'left' | 'right'
    player: LineupPlayer | null
    slotType: string
    placeholderOnly: boolean
    hasGame: boolean
    isLive: boolean
    stats?: LiveStatLine
    fpts: number | null
    matchup?: { opponent: string; isHome: boolean }
    compact: boolean
    dense: boolean
}) {
    const left = side === 'left'
    const align = left ? 'flex-end' : 'flex-start'
    const mirror = (items: ReactNode[]) => (left ? items : [...items].reverse())

    let block: ReactNode
    if (!player) {
        block = (
            <>
                <View style={[styles.nameRow, { justifyContent: align }]}>
                    <Text style={placeholderOnly ? styles.sideMeta : styles.emptySlotText} numberOfLines={1} ellipsizeMode="clip">
                        {placeholderOnly ? STABLE_PLACEHOLDER : emptySlotLabel(slotType)}
                    </Text>
                </View>
                {!dense ? (
                    <View style={[styles.detailRow, { justifyContent: align }]}>
                        <Text style={styles.sideMeta} numberOfLines={1} ellipsizeMode="clip">{STABLE_PLACEHOLDER}</Text>
                    </View>
                ) : null}
            </>
        )
    } else {
        const playedToday = stats != null && !stats.didNotPlay
        const injury = player.injuryStatus ?? null
        const compactBadge = compact && !!injury && !playedToday
        block = (
            <>
                <View style={[styles.nameRow, { justifyContent: align }]}>
                    {mirror([
                        !compact && !playedToday ? <InjuryStatusBadge key="injury" status={injury} /> : null,
                        <Text
                            key="name"
                            style={[styles.sideName, compact && styles.sideNameCompact, dense && styles.sideNameDense, !hasGame && styles.noGameName]}
                            numberOfLines={1}
                            adjustsFontSizeToFit
                            minimumFontScale={0.68}
                            ellipsizeMode="clip"
                        >
                            {compact ? compactLineupName(player.displayName) : shortName(player.displayName)}
                        </Text>,
                        <LineupAvatar key="avatar" player={player} compact={compact} dense={dense} />,
                    ])}
                </View>
                {!dense ? (
                    <View style={[styles.detailRow, { justifyContent: align }]}>
                        {mirror([
                            isLive ? <LiveTag key="live" /> : null,
                            compactBadge ? <InjuryStatusBadge key="injury" status={injury} /> : null,
                            ...(!compact ? (player.eligiblePositions ?? []).map((pos) => <PosTag key={pos} position={pos} />) : []),
                            <Text
                                key="detail"
                                style={[styles.sideMeta, styles.detailText, playedToday && styles.detailTextStats, isLive && styles.statLineLive]}
                                numberOfLines={1}
                                ellipsizeMode="tail"
                            >
                                {detailLine(player.nbaTeam, matchup, stats, compact, compactBadge)}
                            </Text>,
                        ])}
                    </View>
                ) : null}
            </>
        )
    }

    const score = (
        <FantasyScore key="score" value={player ? fpts : null} isLive={isLive} side={side} compact={compact} dense={dense} />
    )
    const body = (
        <View key="body" style={[styles.playerBlock, compact && styles.playerBlockCompact, dense && styles.playerBlockDense, { alignItems: align }]}>
            {block}
        </View>
    )
    return <>{left ? [score, body] : [body, score]}</>
}

type MatchupRowProps = {
    myPlayer: LineupPlayer | null
    oppPlayer: LineupPlayer | null
    slotType: string
    selKind: 'starter' | 'bench' | 'ir' | 'taxi'
    selIndex: number
    isSelected: boolean
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
    targetState?: LineupMoveTargetState
}

function MatchupRowImpl({
    myPlayer,
    oppPlayer,
    slotType,
    selKind,
    selIndex,
    isSelected,
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
    targetState = null,
}: MatchupRowProps) {
    const [expanded, setExpanded] = useState(false)
    const isSel = isSelected
    const slotColor = slotType === 'IR'
        ? uiColors.accentDanger
        : slotType === 'TX'
            ? uiColors.neutralTint
            : (POSITION_COLORS[slotType] ?? uiColors.neutralTint)
    const myStats = myPlayer ? liveStats.get(myPlayer.playerId) : undefined
    const oppStats = oppPlayer ? liveStats.get(oppPlayer.playerId) : undefined
    const myIsLive = myPlayer?.nbaTeam ? liveTeams.has(myPlayer.nbaTeam) : false
    const oppIsLive = oppPlayer?.nbaTeam ? liveTeams.has(oppPlayer.nbaTeam) : false
    const myFpts = myStats && !myStats.didNotPlay ? computeLiveFantasyPoints(myStats, scoringSettings) : null
    const oppFpts = oppStats && !oppStats.didNotPlay ? computeLiveFantasyPoints(oppStats, scoringSettings) : null
    const toggleExpanded = myPlayer || oppPlayer ? () => setExpanded((value) => !value) : undefined

    return (
        <MotionView style={styles.matchupRowWrap} preset="fade" delay={motionDelay}>
            <View
                style={[
                    styles.matchupRow,
                    compact && styles.matchupRowCompact,
                    dense && styles.matchupRowDense,
                ]}
            >
            <MotionPressable
                style={[styles.rowSideLeft, compact && styles.rowSideCompact]}
                onPress={toggleExpanded}
                disabled={!myPlayer}
                accessibilityRole="button"
                accessibilityLabel={myPlayer ? `Stat details for ${myPlayer.displayName}` : 'Toggle matchup stat details'}
                accessibilityState={{ expanded }}
                pressedScale={0.985}
            >
                <PlayerSide
                    side="left"
                    player={myPlayer}
                    slotType={slotType}
                    placeholderOnly={isExtraOppRow}
                    hasGame={myPlayer?.nbaTeam ? playingTeams.has(myPlayer.nbaTeam) : false}
                    isLive={myIsLive}
                    stats={myStats}
                    fpts={myFpts}
                    matchup={myPlayer?.nbaTeam ? teamMatchups.get(myPlayer.nbaTeam) : undefined}
                    compact={compact}
                    dense={dense}
                />
            </MotionPressable>

            <MotionPressable
                style={[
                    styles.slotChipCenter,
                    compact && styles.slotChipCenterCompact,
                    dense && styles.slotChipCenterDense,
                    { backgroundColor: alpha(slotColor, 0.13) },
                    isSel && styles.slotChipSelected,
                    targetState === 'valid' && styles.slotChipTarget,
                    targetState === 'invalid' && styles.slotChipUnavailable,
                    saving && { opacity: 0.4 },
                ]}
                onPress={isExtraOppRow ? undefined : () => onTap({ kind: selKind, index: selIndex })}
                disabled={saving || isExtraOppRow || targetState === 'invalid'}
                accessibilityRole="button"
                accessibilityLabel={myPlayer
                    ? `Select ${slotType} slot, ${myPlayer.displayName}`
                    : `Select empty ${slotType} slot ${selIndex + 1}`}
                accessibilityHint={targetState === 'valid' ? `Move the selected player to ${slotType}` : undefined}
                accessibilityState={{ disabled: saving || isExtraOppRow || targetState === 'invalid', selected: isSel }}
                hitSlop={dense ? 10 : 7}
                pressedScale={0.88}
            >
                <Text style={[styles.slotChipText, { color: isSel ? colors.primary : slotColor }]}>
                    {isExtraOppRow ? '—' : slotType}
                </Text>
            </MotionPressable>

            <MotionPressable
                style={[styles.rowSideRight, compact && styles.rowSideCompact]}
                onPress={toggleExpanded}
                disabled={!oppPlayer}
                accessibilityRole="button"
                accessibilityLabel={oppPlayer ? `Stat details for ${oppPlayer.displayName}` : 'Toggle matchup stat details'}
                accessibilityState={{ expanded }}
                pressedScale={0.985}
            >
                <PlayerSide
                    side="right"
                    player={oppPlayer}
                    slotType={slotType}
                    placeholderOnly={false}
                    hasGame={oppPlayer?.nbaTeam ? playingTeams.has(oppPlayer.nbaTeam) : false}
                    isLive={oppIsLive}
                    stats={oppStats}
                    fpts={oppFpts}
                    matchup={oppPlayer?.nbaTeam ? teamMatchups.get(oppPlayer.nbaTeam) : undefined}
                    compact={compact}
                    dense={dense}
                />
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
        paddingVertical: spacing.sm,
        gap: spacing.md,
    },
    matchupRowCompact: {
        paddingVertical: spacing.xs,
        gap: spacing.xs,
    },
    matchupRowDense: {
        paddingVertical: spacing.xxs,
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
    rowSideCompact: { paddingLeft: 0, paddingRight: 0 },
    playerBlock: { flex: 1, minWidth: 0, minHeight: 48, justifyContent: 'center', gap: spacing.xxs },
    playerBlockCompact: { minHeight: 44 },
    playerBlockDense: { minHeight: 28 },
    fptsNum: {
        fontSize: fontSize.xl,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        width: 64,
        flexShrink: 0,
        textAlign: 'left',
        marginRight: spacing.sm,
        fontVariant: ['tabular-nums'] as const,
    },
    fptsNumCompact: { width: 40, fontSize: fontSize.lg },
    fptsNumDense: { width: 54, fontSize: fontSize.lg },
    fptsRight: { textAlign: 'right', marginRight: 0, marginLeft: spacing.sm },
    fptsLeftCompact: { marginRight: spacing.xs },
    fptsRightCompact: { marginLeft: spacing.xs },
    fptsPlaceholder: { color: colors.textPlaceholder },
    fptsLive: { color: colors.primaryDark },
    sideName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary, flexShrink: 1 },
    emptySlotText: { fontSize: fontSize['2sm'], fontWeight: fontWeight.medium, color: colors.textPlaceholder },
    sideNameCompact: { fontSize: fontSize.sm },
    sideNameDense: { fontSize: fontSize['2sm'] },
    noGameName: { color: colors.textDisabled },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 28, maxWidth: '100%' },
    detailRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 16, maxWidth: '100%' },
    sideMeta: { fontSize: fontSize.xs, color: colors.textPlaceholder },
    detailText: { flexShrink: 1, minWidth: 0 },
    detailTextStats: { color: colors.textMuted },
    lockedBadge: { fontSize: fontSize['2xs'], fontWeight: fontWeight.bold, color: uiColors.successTextLive, letterSpacing: 0.4 },
    liveBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xxs },
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
        width: 38,
        height: 26,
        borderRadius: 7,
    },
    slotChipCenterDense: {
        width: 38,
        height: 24,
    },
    slotChipSelected: { borderWidth: 1.5, borderColor: colors.primary },
    slotChipTarget: { borderWidth: 2, borderColor: colors.success, backgroundColor: colors.successLight },
    slotChipUnavailable: { opacity: 0.25 },
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
        fontSize: fontSize['2xs'],
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
