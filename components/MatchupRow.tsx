import { useFittedText } from '@/components/ui/useFittedText'
import { memo, type ReactNode } from 'react'
import { View, Text, StyleSheet, Platform } from 'react-native'
import { LineupPlayer } from '@/lib/lineup'
import { LiveStatLine } from '@/lib/games'
import { computeLiveFantasyPoints } from '@/lib/scoring'
import { slotColor } from '@/constants/positions'
import { alpha, borderWidth, colors, componentTokens, controlSize, fontWeight, radii, spacing, textStyles, uiColors, typeScale } from '@/constants/tokens'
import { PosTag } from '@/components/PosTag'
import { TeamLogo } from '@/components/TeamLogo'
import { InjuryTag } from '@/components/InjuryTag'
import { InjuryBadge } from '@/components/Badge'
import { formatAvgPoints, formatPoints, playerHeadshotUrl } from '@/lib/format'
import type { StatColumn } from '@/lib/score-breakdown'
import { MotionPressable, MotionView } from '@/components/Motion'
import { Avatar } from '@/components/Avatar'
import { formatLeagueClock } from '@/lib/timezone'
import { LOGO_CHARS, matchupName } from '@/components/player/matchup-name'

const SLOT_W = componentTokens.matchupRow.slotWidth
const FPTS_W = componentTokens.matchupRow.pointsWidth
const STAT_COL_W = componentTokens.matchupRow.statWidth
const STAT_COL_WIDE_W = componentTokens.matchupRow.wideStatWidth
const NAME_MIN_W = componentTokens.matchupRow.nameMinWidth
const COMPACT_SCORE_W = componentTokens.matchupRow.statWidth
const STABLE_PLACEHOLDER = '—'

export type MatchupGame = { opponent: string; isHome: boolean; gameTime?: string | null; status?: string; statusText?: string | null; timezone?: string }

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

/** "Q3 5:23" → "Q3", "OT1 2:00" → "OT", "2OT 1:04" → "2OT", "Halftime" → "Half"; null when unreadable. */
export function gamePeriodLabel(statusText: string | null | undefined): string | null {
    const text = statusText?.trim() ?? ''
    if (/^half/i.test(text)) return 'Half'
    const quarter = /\bQ([1-4])\b/i.exec(text) ?? /\b([1-4])(?:st|nd|rd|th)\s+(?:qtr|quarter)\b/i.exec(text)
    if (quarter) return `Q${quarter[1]}`
    const overtime = /\b(\d+)?OT(\d+)?\b/i.exec(text) ?? /\b(\d+)(?:st|nd|rd|th)\s+(?:overtime)\b/i.exec(text)
    if (overtime) {
        const count = Number(overtime[1] ?? overtime[2] ?? 1)
        return count > 1 ? `${count}OT` : 'OT'
    }
    return null
}

/** The player's team first, then Final, the live period, or the tip time. */
function matchupParts(team: string | null | undefined, matchup: MatchupGame | undefined, timezone?: string) {
    if (!team || !matchup) return null
    const time = matchup.gameTime ? formatLeagueClock(matchup.gameTime, matchup.timezone ?? timezone) : null
    const period = matchup.status === 'InProgress' ? gamePeriodLabel(matchup.statusText) : null
    const suffix = matchup.status === 'Final' ? 'Final' : period ?? (time && time !== 'unknown' ? time : null)
    return { team, opponent: matchup.opponent, joiner: matchup.isHome ? 'vs' : '@', suffix }
}

/** "TOR vs OKC Q3" at home, "TOR @ OKC Q3" away — read aloud, and used to fit the line. */
function matchupLine(parts: ReturnType<typeof matchupParts>): string {
    return parts ? [parts.team, parts.joiner, parts.opponent, parts.suffix].filter(Boolean).join(' ') : ''
}

const GAME_LOGO_SIZE = 14


// The name and game lines stack beside the headshot, which is as tall as both together.
const NAME_LINE_HEIGHT = textStyles.rowTitle.lineHeight
const AVATAR_FRAME = NAME_LINE_HEIGHT + spacing.xxs + componentTokens.matchupRow.gameLineHeight

function LineupAvatar({ player }: { player: LineupPlayer }) {
    const size = AVATAR_FRAME - 2
    return (
        <View style={styles.avatarSlot}>
            <View testID="matchup-player-avatar" style={[styles.lineupAvatarFrame, { width: AVATAR_FRAME, height: AVATAR_FRAME, borderRadius: AVATAR_FRAME / 2 }]}>
                <Avatar
                    name={player.displayName}
                    uri={playerHeadshotUrl(player.nbaId && /^\d+$/.test(player.nbaId) ? player.nbaId : null) ?? undefined}
                    color={colors.bgMuted}
                    textColor={colors.textSecondary}
                    size={size}
                />
            </View>
            <InjuryTag status={player.injuryStatus} avatarSize={AVATAR_FRAME} />
        </View>
    )
}

// G and F only restate PG/SG and SF/PF; rows keep the space for the game line.
function specificPositions(positions: string[] | null | undefined): string[] {
    const list = positions ?? []
    const specific = list.filter((pos) => pos !== 'G' && pos !== 'F' && pos !== 'UTIL')
    return specific.length > 0 ? specific : list
}

function LiveTag() {
    return (
        <View style={styles.liveBadgeRow} accessibilityLabel="Live">
            <Text style={styles.lockedBadge}>LIVE</Text>
        </View>
    )
}

function FantasyScore({
    value,
    projection,
    isLive,
    isFinal,
    side,
    compact = false,
    dense = false,
}: {
    value: number | null
    /** Before the game starts, a faint projection replaces the dash. */
    projection?: number
    isLive: boolean
    isFinal: boolean
    side: 'left' | 'right'
    compact?: boolean
    dense?: boolean
}) {
    const projected = value == null && projection != null
    const displayValue = value != null ? formatPoints(value) : projected ? formatAvgPoints(projection) : '-'
    return (
        <Text
            style={[
                styles.fptsNum,
                compact && styles.fptsNumCompact,
                dense && styles.fptsNumDense,
                side === 'left' && styles.fptsLeft,
                side === 'left' && compact && styles.fptsLeftCompact,
                side === 'right' && compact && styles.fptsRightCompact,
                value == null && styles.fptsPlaceholder,
                projected && styles.fptsProjected,
                value != null && isLive && styles.fptsLive,
                value != null && isFinal && styles.fptsFinal,
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
                <View style={styles.playerBlockSpacer} />
                {labels}
                <Text style={[styles.columnLabel, styles.columnLabelFpts, styles.columnLabelLeft]}>FP</Text>
            </View>
            <View style={{ width: SLOT_W }} />
            <View style={styles.rowSideRight}>
                <Text style={[styles.columnLabel, styles.columnLabelFpts]}>FP</Text>
                {labels}
                <View style={styles.playerBlockSpacer} />
            </View>
        </View>
    )
}

// One half of a head-to-head row. The left half (mine) mirrors the right half
// (opponent) so both scores sit next to the slot chip and headshots sit outside.
function PlayerSide({
    side,
    player,
    slotType,
    placeholderOnly,
    hasGame,
    isLive,
    stats,
    fpts,
    isFinal,
    matchup,
    timezone,
    compact,
    dense,
    statColumns,
    onOpenPlayer,
    onOpenDetails,
    projection,
}: {
    side: 'left' | 'right'
    player: LineupPlayer | null
    slotType: string
    placeholderOnly: boolean
    hasGame: boolean
    isLive: boolean
    stats?: LiveStatLine
    fpts: number | null
    isFinal: boolean
    matchup?: MatchupGame
    timezone?: string
    compact: boolean
    dense: boolean
    statColumns: StatColumn[] | null
    onOpenPlayer?: () => void
    onOpenDetails?: () => void
    /** Shown faintly in place of the dash until the game starts. */
    projection?: number
}) {
    // The team logo shares the name's line, so it takes part of the name's character budget.
    const displayName = player ? matchupName(player.displayName, player.nbaTeam ? LOGO_CHARS : 0) : ''
    const nameRef = useFittedText(displayName)
    const gameParts = player ? matchupParts(player.nbaTeam, matchup, timezone) : null
    const detail = matchupLine(gameParts)
    const detailRef = useFittedText(gameParts?.suffix ?? '', true, 1)
    const left = side === 'left'
    const align = left ? 'flex-start' : 'flex-end'
    const mirror = (items: ReactNode[]) => (left ? items : [...items].reverse())

    let block: ReactNode
    if (!player) {
        // One line only, so the fixed-height block centres "Empty" in the row.
        block = (
            <>
                <View style={[styles.nameRow, compact && styles.nameRowCompact, { justifyContent: align }]}>
                    <Text style={placeholderOnly ? styles.sideMeta : styles.emptySlotText} numberOfLines={1} ellipsizeMode="clip">
                        {placeholderOnly ? STABLE_PLACEHOLDER : compact ? 'Empty' : emptySlotLabel(slotType)}
                    </Text>
                </View>
            </>
        )
    } else {
        const playedToday = stats != null && !stats.didNotPlay
        const injury = player.injuryStatus ?? null
        // A ruled-out player's team can be live without him, so the tag would mislead.
        const sittingOut = !playedToday && injury?.toLowerCase() === 'out'
        const gameTextStyle = [styles.sideMeta, matchup && styles.gameText, playedToday && !compact && styles.detailTextStats, isLive && styles.statLineLive]
        const badge = <InjuryBadge key="injury" status={injury} />
        const name = (
            <Text
                key="name"
                ref={nameRef}
                adjustsFontSizeToFit
                testID="matchup-player-name"
                style={[styles.sideName, compact && styles.sideNameCompact, dense && styles.sideNameDense, !hasGame && styles.noGameName]}
                numberOfLines={1}
                ellipsizeMode="clip"
            >
                {displayName}
            </Text>
        )
        const logo = player.nbaTeam ? <TeamLogo key={`logo-${player.nbaTeam}`} team={player.nbaTeam} size={GAME_LOGO_SIZE} textStyle={styles.sideMeta} /> : null
        const text = (
            <View key="text" testID="matchup-player-text" style={[styles.playerText, { alignItems: align }]}>
                <View style={[styles.nameRow, compact && styles.nameRowCompact, styles.nameRowBesideAvatar, { justifyContent: align }]}>
                    {/* The badge mirrors to the outer edge; the team logo always follows the name. */}
                    {left ? [badge, name, logo] : [name, logo, badge]}
                </View>
                {/* With no game the second line is blank, so drop it and let the name centre in the row. */}
                {detail || hasGame || !compact ? (
                    <View style={[styles.detailRow, { justifyContent: align }]}>
                        {mirror([
                            isLive && !sittingOut && !compact ? <LiveTag key="live" /> : null,
                            ...(!compact ? specificPositions(player.eligiblePositions).map((pos) => <PosTag key={pos} position={pos} />) : []),
                            // "@ [opponent logo] Final" as a row, so the logo centres on the text like the one by the name.
                            gameParts ? (
                                <View key="detail" testID="matchup-game-line" accessible accessibilityLabel={detail} style={[styles.gameLine, { justifyContent: align }]}>
                                    <Text style={[gameTextStyle, styles.gameFixed]} numberOfLines={1}>{gameParts.joiner}</Text>
                                    <TeamLogo key={`opponent-${gameParts.opponent}`} team={gameParts.opponent} size={GAME_LOGO_SIZE} textStyle={gameTextStyle} />
                                    {gameParts.suffix ? (
                                        <Text ref={detailRef} adjustsFontSizeToFit style={[gameTextStyle, styles.gameSuffix]} numberOfLines={1} ellipsizeMode="clip">
                                            {gameParts.suffix}
                                        </Text>
                                    ) : null}
                                </View>
                            ) : (
                                <Text key="detail" testID="matchup-game-line" style={[styles.sideMeta, styles.detailText]} numberOfLines={1} ellipsizeMode="clip">{'\u00a0'}</Text>
                            ),
                        ])}
                    </View>
                ) : null}
            </View>
        )
        block = <View style={[styles.playerContent, { justifyContent: align }]}>
            {mirror([<LineupAvatar key="avatar" player={player} />, text])}
        </View>
    }

    // No score until the player's game has begun (or they have no game); a DNP in a started game is 0.
    const gameStarted = stats != null || isLive || matchup?.status === 'InProgress' || matchup?.status === 'Final'
    const score = (
        <MotionPressable key="score" style={[styles.scoreTarget, compact && styles.scoreTargetCompact]} onPress={onOpenDetails} disabled={!player || !onOpenDetails}
            accessibilityRole="button" accessibilityLabel={player ? `Score breakdown for ${player.displayName}` : 'Empty score'}>
            <FantasyScore value={player && gameStarted ? fpts ?? 0 : null}
                isLive={isLive} isFinal={isFinal} side={side} compact={compact} dense={dense} />
        </MotionPressable>
    )
    const body = (
        <MotionPressable key="body" style={[styles.playerBlock, compact && styles.playerBlockCompact, dense && !compact && styles.playerBlockDense, { alignItems: align }]}
            onPress={onOpenPlayer} disabled={!player || !onOpenPlayer} accessibilityRole="button"
            accessibilityLabel={player ? `Open ${player.displayName} player profile` : emptySlotLabel(slotType)}>
            {block}
        </MotionPressable>
    )
    const cells = statColumns ? <StatCells key="cells" columns={statColumns} stats={player ? stats : undefined} isLive={isLive} /> : null
    return <>{left ? [body, cells, score] : [score, cells, body]}</>
}

type MatchupRowProps = {
    myPlayer: LineupPlayer | null
    oppPlayer: LineupPlayer | null
    slotType: string
    slotIndex: number
    playingTeams: Set<string>
    liveStats: Map<string, LiveStatLine>
    liveTeams: Set<string>
    onCourt?: Set<string>
    scoringSettings: Record<string, number>
    teamMatchups: Map<string, MatchupGame>
    timezone?: string
    isExtraOppRow?: boolean
    compact?: boolean
    dense?: boolean
    motionDelay?: number
    statColumns?: StatColumn[] | null
    onOpenPlayer?: (player: LineupPlayer) => void
    onOpenDetails?: (row: { myPlayer: LineupPlayer | null; oppPlayer: LineupPlayer | null; slotType: string }) => void
    projections?: Map<string, number>
}

function MatchupRowImpl({
    myPlayer,
    oppPlayer,
    slotType,
    slotIndex,
    playingTeams,
    liveStats,
    liveTeams,
    scoringSettings,
    teamMatchups,
    timezone,
    isExtraOppRow = false,
    compact = false,
    dense = false,
    motionDelay = 0,
    statColumns = null,
    onOpenDetails,
    onOpenPlayer,
    projections,
}: MatchupRowProps) {
    const chipColor = slotColor(slotType)
    // Starter and IR labels are heavier than bench and taxi so starters read first.
    const strongSlot = slotType !== 'BE' && slotType !== 'TX'
    const myStats = myPlayer ? liveStats.get(myPlayer.playerId) : undefined
    const oppStats = oppPlayer ? liveStats.get(oppPlayer.playerId) : undefined
    // IR and taxi players don't score, so their rows skip the LIVE tag (and keep room for the team).
    const reserveSlot = slotType === 'IR' || slotType === 'TX'
    const myIsLive = !reserveSlot && myPlayer?.nbaTeam ? liveTeams.has(myPlayer.nbaTeam) : false
    const oppIsLive = !reserveSlot && oppPlayer?.nbaTeam ? liveTeams.has(oppPlayer.nbaTeam) : false
    const myIsFinal = !reserveSlot && myPlayer?.nbaTeam ? teamMatchups.get(myPlayer.nbaTeam)?.status === 'Final' : false
    const oppIsFinal = !reserveSlot && oppPlayer?.nbaTeam ? teamMatchups.get(oppPlayer.nbaTeam)?.status === 'Final' : false
    const myFpts = myStats && !myStats.didNotPlay ? computeLiveFantasyPoints(myStats, scoringSettings) : null
    const oppFpts = oppStats && !oppStats.didNotPlay ? computeLiveFantasyPoints(oppStats, scoringSettings) : null
    const myActive = myIsLive && !myStats?.didNotPlay
    const oppActive = oppIsLive && !oppStats?.didNotPlay
    const openDetails = onOpenDetails && (myPlayer || oppPlayer)
        ? () => onOpenDetails({ myPlayer, oppPlayer, slotType })
        : undefined

    return (
        <MotionView preset="fade" delay={motionDelay}>
            <View
                style={[
                    styles.matchupRow,
                    compact && styles.matchupRowCompact,
                    dense && styles.matchupRowDense,
                ]}
            >
            <View style={[styles.rowSideLeft, compact && styles.rowSideLeftCompact, myActive && styles.sideActive, myActive && styles.sideActiveLeft]}>
                <PlayerSide
                    side="left"
                    player={myPlayer}
                    slotType={slotType}
                    placeholderOnly={isExtraOppRow}
                    hasGame={myPlayer?.nbaTeam ? playingTeams.has(myPlayer.nbaTeam) : false}
                    isLive={myIsLive}
                    stats={myStats}
                    fpts={myFpts}
                    isFinal={myIsFinal}
                    matchup={myPlayer?.nbaTeam ? teamMatchups.get(myPlayer.nbaTeam) : undefined}
                    timezone={timezone}
                    compact={compact}
                    dense={dense}
                    statColumns={statColumns}
                    onOpenDetails={openDetails}
                    onOpenPlayer={myPlayer && onOpenPlayer ? () => onOpenPlayer(myPlayer) : undefined}
                    projection={!reserveSlot && myPlayer ? projections?.get(myPlayer.playerId) : undefined}
                />
            </View>

            <View
                style={[
                    styles.slotChipCenter,
                    compact && styles.slotChipCenterCompact,
                    { backgroundColor: alpha(chipColor, 0.13) },
                ]}
                accessibilityLabel={isExtraOppRow ? undefined : myPlayer
                    ? `${slotType} slot, ${myPlayer.displayName}`
                    : `Empty ${slotType} slot ${slotIndex + 1}`}
            >
                <Text style={[styles.slotChipText, strongSlot && styles.slotChipTextStrong, { color: chipColor }]}>
                    {isExtraOppRow ? '—' : slotType}
                </Text>
            </View>

            <View style={[styles.rowSideRight, compact && styles.rowSideRightCompact, oppActive && styles.sideActive, oppActive && styles.sideActiveRight]}>
                <PlayerSide
                    side="right"
                    player={oppPlayer}
                    slotType={slotType}
                    placeholderOnly={false}
                    hasGame={oppPlayer?.nbaTeam ? playingTeams.has(oppPlayer.nbaTeam) : false}
                    isLive={oppIsLive}
                    stats={oppStats}
                    fpts={oppFpts}
                    isFinal={oppIsFinal}
                    matchup={oppPlayer?.nbaTeam ? teamMatchups.get(oppPlayer.nbaTeam) : undefined}
                    timezone={timezone}
                    compact={compact}
                    dense={dense}
                    statColumns={statColumns}
                    onOpenDetails={openDetails}
                    onOpenPlayer={oppPlayer && onOpenPlayer ? () => onOpenPlayer(oppPlayer) : undefined}
                    projection={!reserveSlot && oppPlayer ? projections?.get(oppPlayer.playerId) : undefined}
                />
            </View>
            </View>
        </MotionView>
    )
}

export const MatchupRow = memo(MatchupRowImpl)

const styles = StyleSheet.create({
    matchupRow: {
        borderBottomWidth: borderWidth.thin,
        borderBottomColor: colors.separator,
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: componentTokens.matchupRow.paddingVertical,
        gap: componentTokens.matchupRow.gap,
    },
    matchupRowCompact: {
        paddingVertical: spacing.none,
        gap: spacing.md,
    },
    matchupRowDense: {
        paddingVertical: spacing.xxs,
    },
    avatarSlot: { flexShrink: 0 },
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
    sideActive: { alignSelf: 'stretch', backgroundColor: colors.primaryLight },
    sideActiveLeft: { borderLeftWidth: borderWidth.accent, borderLeftColor: colors.primary, paddingLeft: spacing.md - borderWidth.accent, paddingRight: spacing.md, marginRight: -spacing.md },
    sideActiveRight: { borderRightWidth: borderWidth.accent, borderRightColor: colors.primary, paddingRight: spacing.md - borderWidth.accent, paddingLeft: spacing.md, marginLeft: -spacing.md },
    rowSideLeftCompact: { paddingLeft: spacing.md, paddingRight: spacing.none },
    rowSideRightCompact: { paddingLeft: spacing.none, paddingRight: spacing.md },
    // Sized to the score itself (three digits) so names get the spare width.
    scoreTarget: { minHeight: controlSize.minTouch, justifyContent: 'center' },
    scoreTargetCompact: { alignSelf: 'center', justifyContent: 'center', alignItems: 'center', width: controlSize.minTouch, marginHorizontal: (COMPACT_SCORE_W - controlSize.minTouch) / 2, zIndex: 1 },
    playerBlock: { flex: 1, minWidth: 0, height: componentTokens.matchupRow.rowHeight, minHeight: componentTokens.matchupRow.rowHeight, justifyContent: 'center', gap: spacing.xxs },
    playerBlockCompact: { minHeight: controlSize.minTouch + spacing.lg },
    playerBlockDense: { minHeight: controlSize.minTouch },
    fptsNum: {
        ...typeScale.number,
        fontWeight: fontWeight.medium,
        color: colors.textMuted,
        width: FPTS_W,
        flexShrink: 0,
        textAlign: 'left',
        marginRight: spacing.sm,
        fontVariant: ['tabular-nums'] as const,
    },
    fptsNumCompact: { ...typeScale.caption, width: COMPACT_SCORE_W },
    fptsNumDense: { ...typeScale.body, width: 40 },
    fptsLeft: { textAlign: 'right', marginRight: spacing.none, marginLeft: spacing.sm },
    fptsLeftCompact: { marginLeft: spacing.none },
    fptsRightCompact: { marginRight: spacing.none },
    fptsPlaceholder: { color: colors.textPlaceholder },
    fptsProjected: { fontWeight: fontWeight.medium },
    // Only finished games are bold; live and upcoming scores stay light.
    fptsFinal: { color: colors.textPrimary, fontWeight: fontWeight.extrabold },
    fptsLive: { color: colors.primaryDark },
    sideName: { ...typeScale.small, fontWeight: fontWeight.bold, color: colors.textPrimary, flexShrink: 1 },
    emptySlotText: { ...typeScale.small, fontWeight: fontWeight.medium, color: colors.textPlaceholder },
    sideNameCompact: { ...textStyles.rowTitle, ...typeScale.micro, fontWeight: fontWeight.bold, flexShrink: 1, minWidth: 0, ...(Platform.OS === 'web' ? { textOverflow: 'clip' as const } : {}) },
    sideNameDense: { ...typeScale.caption },
    noGameName: { color: colors.textMuted },
    playerContent: { flex: 1, width: '100%', flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minWidth: 0 },
    playerText: { flex: 1, minWidth: 0, justifyContent: 'center', gap: spacing.xxs },
    // The headshot moved out of the name line, so the line only needs the text's height.
    nameRowBesideAvatar: { height: NAME_LINE_HEIGHT },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, height: componentTokens.matchupRow.nameLineHeight, maxWidth: '100%' },
    nameRowCompact: { maxWidth: '100%', minWidth: 0, height: componentTokens.matchupRow.compactNameLineHeight, gap: spacing.xxs, flexShrink: 1 },
    gameText: { color: colors.textPrimary, fontWeight: fontWeight.semibold },
    gameLine: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.xxs },
    // "vs"/"@" and the logo never shrink; only the time gives up space.
    gameFixed: { flexShrink: 0 },
    gameSuffix: { flexShrink: 1, minWidth: 0, ...(Platform.OS === 'web' ? { textOverflow: 'clip' as const } : {}) },
    statSummary: { ...textStyles.meta, ...typeScale.micro },
    detailRow: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: spacing.xxs, height: componentTokens.matchupRow.gameLineHeight, maxWidth: '100%' },
    sideMeta: { ...textStyles.meta, ...typeScale.caption },
    detailText: { flex: 1, minWidth: 0, ...(Platform.OS === 'web' ? { textOverflow: 'clip' as const } : {}) },
    detailTextStats: { color: colors.textMuted },
    lockedBadge: { ...typeScale.micro, fontWeight: fontWeight.bold, color: uiColors.successTextLive },
    liveBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xxs },
    statLineLive: { color: colors.primaryDark, fontWeight: fontWeight.semibold },
    slotChipCenter: {
        width: SLOT_W,
        height: controlSize.minTouch,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    slotChipCenterCompact: {
        width: controlSize.minTouch,
        height: controlSize.minTouch,
        borderRadius: radii.md,
    },
    slotChipText: { ...typeScale.caption, fontWeight: fontWeight.extrabold },
    slotChipTextStrong: { fontWeight: fontWeight.black },
    statCells: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
    statCell: {
        ...typeScale.small,
        fontWeight: fontWeight.semibold,
        color: colors.textSecondary,
        textAlign: 'center',
        fontVariant: ['tabular-nums'] as const,
    },
    statCellEmpty: { color: colors.textDisabled, fontWeight: fontWeight.regular },
    statCellLive: { color: colors.primaryDark },
    columnHeader: { paddingVertical: spacing.xs, borderBottomWidth: 1, borderBottomColor: colors.separator },
    columnLabel: { ...textStyles.sectionLabel, ...typeScale.micro, textAlign: 'center' },
    columnLabelFpts: { width: FPTS_W, marginRight: spacing.sm, textAlign: 'left' },
    columnLabelLeft: { marginRight: spacing.none, marginLeft: spacing.sm, textAlign: 'right' },
    playerBlockSpacer: { flex: 1, minWidth: NAME_MIN_W },
})
