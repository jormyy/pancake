import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { View, Text, StyleSheet, Pressable } from 'react-native'
import { memo } from 'react'
import { claimProcessWeekdayLabel } from '@/lib/waivers'
import { PlayerRow, getEligiblePositions } from '@/lib/players'
import { formatPoints } from '@/lib/format'
import { OwnedEntry } from '@/lib/roster'
import { INJURY_COLORS, colors, controlSize, fontSize, fontWeight, radii, spacing, table, textStyles, uiColors } from '@/constants/tokens'
import { PlayerAvatar } from '@/components/player/PlayerAvatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { MotionPressable, MotionView } from '@/components/Motion'
import { blockedActionProps } from '@/lib/a11y'
import {
    formatProjectionGame,
    numberOrDash,
} from '@/lib/projections'

function PlayerSearchItemImpl({
    item,
    currentMemberId,
    ownedMap,
    waiverIds,
    waiverClearsAt = null,
    claimPending = false,
    isAdding,
    addToIR = false,
    addDisabled = false,
    showStats = false,
    showCompactStats = true,
    statMode = 'season',
    animate = true,
    addBlockedReason = null,
    onAdd,
    onPress,
}: {
    item: PlayerRow
    currentMemberId: string | undefined
    ownedMap: Map<string, OwnedEntry>
    waiverIds: Set<string>
    waiverClearsAt?: string | null
    claimPending?: boolean
    addToIR?: boolean
    isAdding: boolean
    addDisabled?: boolean
    showStats?: boolean
    showCompactStats?: boolean
    statMode?: 'season' | 'projection'
    animate?: boolean
    /** Why a free-agent add is unavailable right now (weekly add limit). The button stays pressable so the tap explains it; claims are gated by the claim modal. */
    addBlockedReason?: string | null
    onAdd: (player: PlayerRow) => void
    onPress: (player: PlayerRow) => void
}) {
    const owned = ownedMap.get(item.id)
    const isMe = owned?.memberId === currentMemberId
    const isOther = owned && !isMe
    const isWaiver = !owned && waiverIds.has(item.id)
    const isFA = !owned && !isWaiver
    const canAdd = currentMemberId && (isFA || isWaiver)
    const blockedReason = isWaiver ? null : addBlockedReason
    const projectionGame = formatProjectionGame({
        projection_date: item.projection_date ?? null,
        next_game_date: item.projection_date ?? null,
        next_game_opponent: item.projection_opponent ?? null,
    })
    const stats = playerStats(item, statMode)
    // The projection header line already leads with "<n> FP"; repeating FP in
    // the compact stat stack read as a duplicate to reviewers.
    const compactStats = (statMode === 'projection' && item.projection_fantasy_points != null
        ? stats.slice(1)
        : stats
    ).slice(0, 7)
    // Narrow projection lists (Projections tab on phones) collapse to a dense
    // row: FP beside the name, game/minutes/ownership folded into the meta row,
    // and the stat strip as the only block below — so several players fit per
    // screen instead of one tall card.
    const denseProjectionRow = statMode === 'projection' && !showStats

    // The wide table has an Ownership column, so free agents say "FA" there too.
    const statusBadge = currentMemberId && (!isFA || showStats) ? (
        <View style={[
            styles.statusBadge,
            !showStats && styles.statusBadgeNarrow,
            isMe && styles.statusBadgeMe,
            isWaiver && styles.statusBadgeWaiver,
            isFA && styles.statusBadgeFA,
        ]}>
            <Text
                style={[
                    styles.statusBadgeText,
                    isMe && styles.statusBadgeTextMe,
                    isWaiver && styles.statusBadgeTextWaiver,
                ]}
                numberOfLines={1}
            >
                {isMe ? 'Mine'
                    : isOther ? owned!.teamName
                    : isWaiver ? `W · ${claimProcessWeekdayLabel(waiverClearsAt)}`
                    : 'FA'}
            </Text>
        </View>
    ) : null

    const content = (
        <>
            <View style={styles.addCol}>
                {canAdd ? (
                    <MotionPressable
                        style={styles.addTarget}
                        onPress={() => onAdd(item)}
                        disabled={isAdding || addDisabled}
                        accessibilityRole="button"
                        accessibilityLabel={claimPending ? `Claim pending for ${item.display_name}, view claims` : `${isWaiver ? 'Claim' : addToIR ? 'Add to IR' : 'Add'} ${item.display_name}`}
                        {...blockedActionProps(blockedReason, isAdding || addDisabled)}
                        hitSlop={8}
                        pressedScale={0.88}
                    >
                        <View style={[styles.addBtn, isWaiver && styles.addBtnWaiver, blockedReason ? styles.addBtnBlocked : null]}>
                            {claimPending ? <MaterialIcons name="schedule" size={20} color={uiColors.waiverText} /> : <Text style={[styles.addBtnText, isWaiver && styles.addBtnTextWaiver, blockedReason ? styles.addBtnTextBlocked : null]} numberOfLines={1}>{isWaiver ? 'Claim' : addToIR ? 'Add to IR' : 'Add'}</Text>}
                        </View>
                    </MotionPressable>
                ) : null}
            </View>

            <Pressable
                style={[styles.playerCard, !showStats && styles.playerCardNarrow, denseProjectionRow && styles.playerCardDense]}
                onPress={() => onPress(item)}
                accessibilityRole="button"
                accessibilityLabel={`Open ${item.display_name}`}
            >
                <PlayerAvatar name={item.display_name} nbaId={item.nba_id} color={colors.bgMuted} size={HEADSHOT} />

                <View style={styles.playerInfo}>
                    {denseProjectionRow ? (
                        <View style={styles.nameScoreRow}>
                            <Text style={[styles.playerName, styles.playerNameDense]} numberOfLines={1}>
                                {item.display_name}
                            </Text>
                            <Text style={styles.denseScore} numberOfLines={1}>
                                {numberOrDash(item.projection_fantasy_points)} FP
                            </Text>
                        </View>
                    ) : (
                        <Text style={styles.playerName} numberOfLines={1}>{item.display_name}</Text>
                    )}
                    <View style={styles.playerMetaRow}>
                        {item.nba_team && <Text style={styles.playerMeta}>{item.nba_team}</Text>}
                        {getEligiblePositions(item).map((pos: string) => <PosTag key={pos} position={pos} />)}
                        {item.years_exp === 0 && (
                            <Text style={[styles.experienceText, item.years_exp === 0 && { color: colors.success }]}>
                                Rookie
                            </Text>
                        )}
                        {item.injury_status ? (
                            <Badge
                                label={item.injury_status}
                                color={INJURY_COLORS[item.injury_status] ?? colors.textMuted}
                                variant="solid"
                            />
                        ) : null}
                        {denseProjectionRow && projectionGame ? (
                            <Text style={styles.playerMeta} numberOfLines={1}>{projectionGame}</Text>
                        ) : null}
                        {denseProjectionRow ? statusBadge : null}
                    </View>
                    {!showStats && showCompactStats ? (
                        <View style={styles.compactStats}>
                            {compactStats.map((stat) => (
                                <View key={stat.label} style={styles.compactStat}>
                                    <Text style={styles.compactStatLabel}>{stat.label}</Text>
                                    <Text style={[styles.compactStatValue, stat.highlight && styles.compactStatValuePrimary]}>
                                        {formatPoints(stat.value)}
                                    </Text>
                                </View>
                            ))}
                        </View>
                    ) : null}
                </View>

                {denseProjectionRow || !showStats ? null : statusBadge}

                {!showStats && !denseProjectionRow ? (
                    <View style={styles.fpCol}>
                        <Text style={styles.fpValue} numberOfLines={1}>{formatPoints(stats[0]?.value)}</Text>
                        <Text style={[styles.fpLabel, item.playing_now && styles.liveLabel]}>{item.playing_now ? 'LIVE' : 'FP'}</Text>
                        {statusBadge}
                    </View>
                ) : null}

                {showStats ? (
                    <View style={styles.statsGrid}>
                        {stats.map((stat) => (
                            <StatCell
                                key={stat.label}
                                value={stat.value}
                                highlight={stat.highlight}
                                integer={stat.integer}
                            />
                        ))}
                    </View>
                ) : null}
            </Pressable>
        </>
    )

    return animate ? (
        <MotionView style={styles.playerRow} preset="rise">
            {content}
        </MotionView>
    ) : (
        <View style={styles.playerRow}>
            {content}
        </View>
    )
}

export const PlayerSearchItem = memo(PlayerSearchItemImpl)

function playerStats(item: PlayerRow, statMode: 'season' | 'projection') {
    if (statMode === 'projection') {
        return [
            { label: 'FP', value: item.projection_fantasy_points, highlight: true },
            { label: 'MIN', value: item.projection_minutes },
            { label: 'PTS', value: item.projection_points },
            { label: 'REB', value: item.projection_rebounds },
            { label: 'AST', value: item.projection_assists },
            { label: 'STL', value: item.projection_steals },
            { label: 'BLK', value: item.projection_blocks },
            { label: '3PM', value: item.projection_three_pointers_made },
            { label: 'TO', value: item.projection_turnovers },
            { label: 'GP', value: item.projection_games_played, integer: true },
        ]
    }

    return [
        // No fallback to avg_points: rendering plain points as "FP" showed a
        // wrong number that exactly duplicated the PTS column. Null renders "—".
        { label: 'FP', value: item.avg_fantasy_points, highlight: true },
        { label: 'MIN', value: item.avg_minutes_played },
        { label: 'PTS', value: item.avg_points },
        { label: 'REB', value: item.avg_rebounds },
        { label: 'AST', value: item.avg_assists },
        { label: 'STL', value: item.avg_steals },
        { label: 'BLK', value: item.avg_blocks },
        { label: '3PM', value: item.avg_three_pointers_made },
        { label: 'TO', value: item.avg_turnovers },
        { label: 'GP', value: item.games_played, integer: true },
    ]
}

function StatCell({
    value,
    highlight = false,
    integer = false,
}: {
    value?: number | null
    highlight?: boolean
    integer?: boolean
}) {
    const display = value != null && integer ? String(Math.round(Number(value))) : formatPoints(value)
    return (
        <Text style={[styles.statCell, highlight && styles.statCellPrimary]} numberOfLines={1}>
            {display}
        </Text>
    )
}

const ADD_COL_W = controlSize.minTouch + spacing['4xl']
const HEADSHOT = spacing['4xl'] + spacing.xs

/** Geometry the stat-table header mirrors so its columns line up with rows. */
export const playerRowGeometry = {
    addColWidth: ADD_COL_W,
    headshot: HEADSHOT,
    statusWidth: 90,
    statCount: 10,
} as const

const styles = StyleSheet.create({
    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: spacing.sm,
        minHeight: table.rowHeight,
    },
    addCol: { width: ADD_COL_W, alignItems: 'center' },
    // The 44px target wraps a smaller circle so rows stay short.
    addTarget: { width: ADD_COL_W, height: controlSize.minTouch, alignItems: 'center', justifyContent: 'center' },
    addBtn: {
        width: ADD_COL_W - spacing.xs,
        height: HEADSHOT,
        borderRadius: radii.full,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primaryLight,
        borderWidth: 1.5,
        borderColor: colors.primaryBorder,
        alignItems: 'center',
        justifyContent: 'center',
    },
    addBtnWaiver: { backgroundColor: colors.infoLight, borderColor: colors.info, borderWidth: 1 },
    addBtnTextWaiver: { color: uiColors.waiverText },
    addBtnText: { color: colors.primaryDark, fontSize: fontSize.xs, fontWeight: fontWeight.bold, lineHeight: 18 },
    addBtnBlocked: { backgroundColor: colors.bgMuted, borderColor: colors.borderLight },
    addBtnTextBlocked: { color: colors.textPlaceholder },
    playerCard: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: spacing.lg,
        paddingVertical: spacing.sm,
        paddingLeft: spacing.sm,
        gap: spacing.md,
    },
    playerCardNarrow: { paddingRight: spacing.lg },
    playerCardDense: { paddingVertical: spacing.sm, gap: spacing.md },
    playerInfo: { flex: 1, minWidth: 0 },
    playerName: { ...textStyles.rowTitle },
    playerNameDense: { flexShrink: 1 },
    nameScoreRow: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: spacing.md,
    },
    denseScore: {
        flexShrink: 0,
        fontSize: fontSize.lg,
        fontWeight: fontWeight.extrabold,
        color: colors.primaryDark,
        fontVariant: ['tabular-nums'],
    },
    playerMetaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xxs },
    playerMeta: { fontSize: fontSize['2sm'], color: colors.textMuted },
    liveLabel: { color: colors.success, fontWeight: fontWeight.bold },
    compactStats: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.md, rowGap: spacing.xs, marginTop: spacing.sm },
    compactStat: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs },
    compactStatLabel: {
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
        letterSpacing: 0.4,
    },
    compactStatValue: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
        fontVariant: ['tabular-nums'],
    },
    compactStatValuePrimary: { color: colors.primaryDark, fontWeight: fontWeight.extrabold },
    experienceText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.textMuted },
    fpCol: { alignItems: 'flex-end', width: spacing['4xl'] * 2, gap: spacing.xxs },
    fpValue: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.primaryDark, fontVariant: ['tabular-nums'] },
    fpLabel: { ...textStyles.tableHeader, width: '100%', textAlign: 'right', marginTop: -spacing.xxs },
    statsGrid: {
        width: 10 * table.statColWidth,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexShrink: 0,
    },
    statCell: {
        width: table.statColWidth,
        textAlign: 'right',
        ...textStyles.tableCell,
        fontWeight: fontWeight.semibold,
    },
    statCellPrimary: {
        color: colors.primaryDark,
        fontWeight: fontWeight.extrabold,
    },
    statusBadge: {
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xxs,
        borderRadius: radii.sm,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        width: 90,
        alignItems: 'center',
    },
    statusBadgeNarrow: { width: 'auto', minWidth: 40 },
    statusBadgeMe: { backgroundColor: colors.successLight },
    statusBadgeWaiver: { backgroundColor: colors.infoLight },
    statusBadgeFA: { backgroundColor: colors.bgMuted },
    statusBadgeText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textMuted },
    statusBadgeTextMe: { color: colors.successDark },
    statusBadgeTextWaiver: { color: uiColors.waiverText },
})
