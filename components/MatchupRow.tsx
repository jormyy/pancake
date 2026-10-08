import { memo, type ReactNode } from 'react'
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native'
import { LineupPlayer, type LineupMoveTargetState } from '@/lib/lineup'
import { LiveStatLine } from '@/lib/games'
import { computeLiveFantasyPoints } from '@/lib/scoring'
import { POSITION_COLORS } from '@/constants/positions'
import { alpha, colors, fontSize, fontWeight, INJURY_COLORS, radii, spacing, textStyles, uiColors } from '@/constants/tokens'
import { PosTag } from '@/components/PosTag'
import { Badge } from '@/components/Badge'
import { formatPoints, playerHeadshotUrl, shortName } from '@/lib/format'
import type { StatColumn } from '@/lib/score-breakdown'
import { LivePulse, MotionPressable, MotionView } from '@/components/Motion'
import { Avatar } from '@/components/Avatar'

type Sel = { kind: 'starter' | 'bench' | 'ir' | 'taxi'; index: number }

const SLOT_W = 52
const FPTS_W = 64
const STAT_COL_W = 34
const STAT_COL_WIDE_W = 46
const NAME_MIN_W = 130
const STABLE_PLACEHOLDER = '—'

function statColumnsWidth(columns: StatColumn[]): number {
    return columns.reduce((total, column) => total + (column.wide ? STAT_COL_WIDE_W : STAT_COL_W), 0)
}

/** Narrowest lineup that fits box-score columns on both sides of every row. */
export function statLineupWidth(columns: StatColumn[]): number {
    const side = FPTS_W + spacing.sm + statColumnsWidth(columns) + NAME_MIN_W + spacing.sm
    return 2 * side + SLOT_W + 2 * spacing.md
}

function emptySlotLabel(slotType: string): string {
    if (slotType === 'BE') return 'Empty bench slot'
    if (slotType === 'IR') return 'Empty IR slot'
    if (slotType === 'TX') return 'Empty taxi slot'
    return 'No starter'
}

function compactLineupName(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean)
    const last = parts.at(-1) ?? name
    return last.split('-')[0]
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

// One line under the name: the NBA game before tip-off, the box score after.
// It is always present, so rows keep their height when live stats arrive.
function detailLine(
    team: string | null | undefined,
    matchup: { opponent: string; isHome: boolean } | undefined,
    stats: LiveStatLine | undefined,
    compact: boolean,
    compactWithBadge: boolean,
    includeStats: boolean,
): string {
    const game = matchupLine(team, matchup, compact, compactWithBadge)
    if (stats?.didNotPlay) return compact ? 'DNP' : `${game} · DNP`
    if (!stats || !includeStats) return game
    // The points/rebounds/assists slash line fits every width; the full box
    // score is a tap away in the breakdown, or in columns on wide screens.
    const slash = `${stats.points}/${stats.rebounds}/${stats.assists}`
    return compact ? slash : `${game} · ${slash}`
}

// G and F only restate PG/SG and SF/PF; rows keep the space for the game line.
function specificPositions(positions: string[] | null | undefined): string[] {
    const list = positions ?? []
    const specific = list.filter((pos) => pos !== 'G' && pos !== 'F' && pos !== 'UTIL')
    return specific.length > 0 ? specific : list
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

function LiveTag({ dotOnly = false }: { dotOnly?: boolean }) {
    return (
        <View style={styles.liveBadgeRow} accessibilityLabel="Live">
            <LivePulse color={uiColors.successTextLive} size={5} />
            {dotOnly ? null : <Text style={styles.lockedBadge}>LIVE</Text>}
        </View>
    )
}

function FantasyScore({
    value,
    isLive,
    leading,
    side,
    compact = false,
    dense = false,
}: {
    value: number | null
    isLive: boolean
    leading: boolean
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
                value != null && leading && styles.fptsLeading,
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

function StatCells({ columns, stats, isLive }: { columns: StatColumn[]; stats?: LiveStatLine; isLive: boolean }) {
    const played = stats != null && !stats.didNotPlay
    return (
        <View style={styles.statCells}>
            {columns.map((column) => (
                <Text
                    key={column.key}
                    style={[
                        styles.statCell,
                        { width: column.wide ? STAT_COL_WIDE_W : STAT_COL_W },
                        !played && styles.statCellEmpty,
                        played && isLive && styles.statCellLive,
                    ]}
                    numberOfLines={1}
                >
                    {played ? column.value(stats) : '–'}
                </Text>
            ))}
        </View>
    )
}

/** Column labels that line up with the stat cells of the rows below. */
export function MatchupColumnHeader({ columns }: { columns: StatColumn[] }) {
    const labels = (
        <View style={styles.statCells}>
            {columns.map((column) => (
                <Text key={column.key} style={[styles.columnLabel, { width: column.wide ? STAT_COL_WIDE_W : STAT_COL_W }]}>
                    {column.label}
                </Text>
            ))}
        </View>
    )
    return (
        <View style={[styles.matchupRow, styles.columnHeader]} aria-hidden>
            <View style={styles.rowSideLeft}>
                <Text style={[styles.columnLabel, styles.columnLabelFpts]}>FP</Text>
                {labels}
                <View style={styles.playerBlockSpacer} />
            </View>
            <View style={{ width: SLOT_W }} />
            <View style={styles.rowSideRight}>
                <View style={styles.playerBlockSpacer} />
                {labels}
                <Text style={[styles.columnLabel, styles.columnLabelFpts, styles.columnLabelRight]}>FP</Text>
            </View>
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
    leading,
    matchup,
    compact,
    dense,
    statColumns,
}: {
    side: 'left' | 'right'
    player: LineupPlayer | null
    slotType: string
    placeholderOnly: boolean
    hasGame: boolean
    isLive: boolean
    stats?: LiveStatLine
    fpts: number | null
    leading: boolean
    matchup?: { opponent: string; isHome: boolean }
    compact: boolean
    dense: boolean
    statColumns: StatColumn[] | null
}) {
    const left = side === 'left'
    const align = left ? 'flex-end' : 'flex-start'
    // Under 360px wide the avatar costs the name its last letters.
    const { width } = useWindowDimensions()
    const tiny = compact && width < 360
    const mirror = (items: ReactNode[]) => (left ? items : [...items].reverse())

    let block: ReactNode
    if (!player) {
        block = (
            <>
                <View style={[styles.nameRow, { justifyContent: align }]}>
                    <Text style={placeholderOnly ? styles.sideMeta : styles.emptySlotText} numberOfLines={1} ellipsizeMode="clip">
                        {placeholderOnly ? STABLE_PLACEHOLDER : tiny ? 'Empty' : emptySlotLabel(slotType)}
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
                            ellipsizeMode="tail"
                        >
                            {compact ? compactLineupName(player.displayName) : shortName(player.displayName)}
                        </Text>,
                        tiny ? null : <LineupAvatar key="avatar" player={player} compact={compact} dense={dense} />,
                    ])}
                </View>
                {!dense ? (
                    <View style={[styles.detailRow, { justifyContent: align }]}>
                        {mirror([
                            isLive ? <LiveTag key="live" dotOnly={tiny} /> : null,
                            compactBadge ? <InjuryStatusBadge key="injury" status={injury} /> : null,
                            ...(!compact ? specificPositions(player.eligiblePositions).map((pos) => <PosTag key={pos} position={pos} />) : []),
                            <Text
                                key="detail"
                                style={[styles.sideMeta, styles.detailText, playedToday && styles.detailTextStats, isLive && styles.statLineLive]}
                                numberOfLines={1}
                                ellipsizeMode="tail"
                            >
                                {detailLine(player.nbaTeam, matchup, stats, compact, compactBadge, statColumns == null)}
                            </Text>,
                        ])}
                    </View>
                ) : null}
            </>
        )
    }

    const score = (
        <FantasyScore key="score" value={player ? fpts : null} isLive={isLive} leading={leading} side={side} compact={compact} dense={dense} />
    )
    const body = (
        <View key="body" style={[styles.playerBlock, compact && styles.playerBlockCompact, dense && styles.playerBlockDense, { alignItems: align }]}>
            {block}
        </View>
    )
    const cells = statColumns ? <StatCells key="cells" columns={statColumns} stats={player ? stats : undefined} isLive={isLive} /> : null
    return <>{left ? [score, cells, body] : [body, cells, score]}</>
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
    statColumns?: StatColumn[] | null
    onOpenDetails?: (row: { myPlayer: LineupPlayer | null; oppPlayer: LineupPlayer | null; slotType: string }) => void
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
    statColumns = null,
    onOpenDetails,
}: MatchupRowProps) {
    const isSel = isSelected
    const slotColor = slotType === 'IR'
        ? uiColors.accentDanger
        : slotType === 'TX'
            ? uiColors.neutralTint
            : (POSITION_COLORS[slotType] ?? uiColors.neutralTint)
    const myStats = myPlayer ? liveStats.get(myPlayer.playerId) : undefined
    const oppStats = oppPlayer ? liveStats.get(oppPlayer.playerId) : undefined
    // IR and taxi players don't score, so their rows skip the LIVE tag (and keep room for the team).
    const reserveSlot = slotType === 'IR' || slotType === 'TX'
    const myIsLive = !reserveSlot && myPlayer?.nbaTeam ? liveTeams.has(myPlayer.nbaTeam) : false
    const oppIsLive = !reserveSlot && oppPlayer?.nbaTeam ? liveTeams.has(oppPlayer.nbaTeam) : false
    const myFpts = myStats && !myStats.didNotPlay ? computeLiveFantasyPoints(myStats, scoringSettings) : null
    const oppFpts = oppStats && !oppStats.didNotPlay ? computeLiveFantasyPoints(oppStats, scoringSettings) : null
    const openDetails = onOpenDetails && (myPlayer || oppPlayer)
        ? () => onOpenDetails({ myPlayer, oppPlayer, slotType })
        : undefined

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
                onPress={openDetails}
                disabled={!myPlayer}
                accessibilityRole="button"
                accessibilityLabel={myPlayer ? `Score breakdown for ${myPlayer.displayName}` : 'Score breakdown'}
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
                    leading={!reserveSlot && myFpts != null && (oppFpts == null || myFpts > oppFpts)}
                    matchup={myPlayer?.nbaTeam ? teamMatchups.get(myPlayer.nbaTeam) : undefined}
                    compact={compact}
                    dense={dense}
                    statColumns={statColumns}
                />
            </MotionPressable>

            <MotionPressable
                style={[
                    styles.slotChipCenter,
                    compact && styles.slotChipCenterCompact,
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
                hitSlop={7}
                pressedScale={0.88}
            >
                <Text style={[styles.slotChipText, { color: isSel ? colors.primary : slotColor }]}>
                    {isExtraOppRow ? '—' : slotType}
                </Text>
            </MotionPressable>

            <MotionPressable
                style={[styles.rowSideRight, compact && styles.rowSideCompact]}
                onPress={openDetails}
                disabled={!oppPlayer}
                accessibilityRole="button"
                accessibilityLabel={oppPlayer ? `Score breakdown for ${oppPlayer.displayName}` : 'Score breakdown'}
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
                    leading={!reserveSlot && oppFpts != null && (myFpts == null || oppFpts > myFpts)}
                    matchup={oppPlayer?.nbaTeam ? teamMatchups.get(oppPlayer.nbaTeam) : undefined}
                    compact={compact}
                    dense={dense}
                    statColumns={statColumns}
                />
            </MotionPressable>
            </View>
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
    rowSideCompact: { paddingLeft: spacing.xs, paddingRight: spacing.xs },
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
    fptsLeading: { color: colors.textPrimary },
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
        height: 36,
        borderRadius: 8,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    // Phone chips are the tap target for lineup moves, so they stay near 44px,
    // even on the shortest phones.
    slotChipCenterCompact: {
        width: 42,
        height: 40,
        borderRadius: radii.md,
    },
    slotChipSelected: { borderWidth: 1.5, borderColor: colors.primary },
    slotChipTarget: { borderWidth: 2, borderColor: colors.success, backgroundColor: colors.successLight },
    slotChipUnavailable: { opacity: 0.25 },
    slotChipText: { fontSize: fontSize.xs, fontWeight: fontWeight.extrabold, letterSpacing: 0.3 },
    statCells: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
    statCell: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
        color: colors.textSecondary,
        textAlign: 'center',
        fontVariant: ['tabular-nums'] as const,
    },
    statCellEmpty: { color: colors.textDisabled, fontWeight: fontWeight.regular },
    statCellLive: { color: colors.primaryDark },
    columnHeader: { paddingVertical: spacing.xs, borderBottomWidth: 1, borderBottomColor: colors.separator },
    columnLabel: { ...textStyles.sectionLabel, fontSize: fontSize['2xs'], textAlign: 'center' },
    columnLabelFpts: { width: FPTS_W, marginRight: spacing.sm, textAlign: 'left' },
    columnLabelRight: { marginRight: 0, marginLeft: spacing.sm, textAlign: 'right' },
    playerBlockSpacer: { flex: 1, minWidth: NAME_MIN_W },
})
