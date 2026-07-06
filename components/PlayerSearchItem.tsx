import { View, Text, StyleSheet, Image, Pressable } from 'react-native'
import { useState } from 'react'
import { PlayerRow, getEligiblePositions } from '@/lib/players'
import { countLabel, formatPoints, playerHeadshotUrl } from '@/lib/format'
import { OwnedEntry } from '@/lib/roster'
import { getPositionColor } from '@/constants/positions'
import { INJURY_COLORS, colors, fontSize, fontWeight, radii, spacing, uiColors } from '@/constants/tokens'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { MotionPressable, MotionView } from '@/components/Motion'
import {
    formatProjectionGame,
    numberOrDash,
} from '@/lib/projections'

export function PlayerSearchItem({
    item,
    currentMemberId,
    ownedMap,
    waiverIds,
    adding,
    gamesLeft,
    showStats = false,
    showCompactStats = true,
    statMode = 'season',
    animate = true,
    onAdd,
    onPress,
}: {
    item: PlayerRow
    currentMemberId: string | undefined
    ownedMap: Map<string, OwnedEntry>
    waiverIds: Set<string>
    adding: string | null
    gamesLeft: Map<string, number>
    showStats?: boolean
    showCompactStats?: boolean
    statMode?: 'season' | 'projection'
    animate?: boolean
    onAdd: (player: PlayerRow) => void
    onPress: () => void
}) {
    const owned = ownedMap.get(item.id)
    const isMe = owned?.memberId === currentMemberId
    const isOther = owned && !isMe
    const isWaiver = !owned && waiverIds.has(item.id)
    const isFA = !owned && !isWaiver
    const canAdd = currentMemberId && (isFA || isWaiver)
    const isAdding = adding === item.id
    const [headshotError, setHeadshotError] = useState(false)
    const headshotUri = playerHeadshotUrl(item.nba_id)
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

    const statusBadge = currentMemberId && !isFA ? (
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
                    : isWaiver ? 'W'
                    : 'FA'}
            </Text>
        </View>
    ) : null

    const content = (
        <>
            <View style={styles.addCol}>
                {canAdd ? (
                    <MotionPressable
                        style={styles.addBtn}
                        onPress={() => onAdd(item)}
                        disabled={isAdding}
                        accessibilityRole="button"
                        accessibilityLabel={`Add ${item.display_name}`}
                        accessibilityState={{ disabled: isAdding }}
                        hitSlop={8}
                        pressedScale={0.88}
                    >
                        <Text style={styles.addBtnText}>+</Text>
                    </MotionPressable>
                ) : null}
            </View>

            <Pressable
                style={[styles.playerCard, !showStats && styles.playerCardNarrow, denseProjectionRow && styles.playerCardDense]}
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={`Open ${item.display_name}`}
            >
                {headshotUri && !headshotError ? (
                    <Image
                        source={{ uri: headshotUri }}
                        style={[styles.headshot, denseProjectionRow && styles.headshotDense]}
                        onError={() => setHeadshotError(true)}
                    />
                ) : (
                    <Avatar
                        name={item.display_name}
                        color={getPositionColor(item.eligible_positions?.[0] ?? item.position)}
                        size={denseProjectionRow ? 36 : 44}
                    />
                )}

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
                        <Text style={styles.playerName}>{item.display_name}</Text>
                    )}
                    <View style={styles.playerMetaRow}>
                        {item.nba_team && <Text style={styles.playerMeta}>{item.nba_team}</Text>}
                        {getEligiblePositions(item).map((pos: string) => <PosTag key={pos} position={pos} />)}
                        {item.years_exp != null && (
                            <Text style={[styles.gamesLeftText, item.years_exp === 0 && { color: colors.success }]}>
                                {item.years_exp === 0 ? 'Rookie' : `Yr ${item.years_exp + 1}`}
                            </Text>
                        )}
                        {item.nba_team != null && (gamesLeft.get(item.nba_team) ?? 0) > 0 && (
                            <Text style={styles.gamesLeftText}>
                                {countLabel(gamesLeft.get(item.nba_team) ?? 0, 'game')} left
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

                {denseProjectionRow ? null : statusBadge}

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

const styles = StyleSheet.create({
    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: spacing.lg,
        gap: 0,
    },
    addCol: { width: 52, alignItems: 'center' },
    // MotionPressable's touch surface is an absoluteFill overlay inside the
    // border, so the outer circle is padded to 48 to keep the measurable
    // target >= 44px.
    addBtn: {
        width: 48,
        height: 48,
        borderRadius: 24,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primaryLight,
        borderWidth: 1.5,
        borderColor: colors.primaryBorder,
        alignItems: 'center',
        justifyContent: 'center',
    },
    addBtnText: { color: colors.primaryDark, fontSize: fontSize.xl, fontWeight: fontWeight.light, lineHeight: 24, marginTop: -1 },
    playerCard: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: spacing['4xl'],
        paddingVertical: spacing.lg,
        paddingLeft: spacing.md,
        gap: spacing.lg,
    },
    // On narrow viewports top-align the avatar with the name (so it doesn't float
    // mid-row beside the wrapped stat strip) and tighten the right padding.
    playerCardNarrow: { alignItems: 'flex-start', paddingRight: spacing.lg },
    playerCardDense: { paddingVertical: spacing.md, gap: spacing.md },
    headshot: {
        width: 44,
        height: 44,
        borderRadius: 22,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    headshotDense: { width: 36, height: 36, borderRadius: 18 },
    playerInfo: { flex: 1, minWidth: 0 },
    playerName: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold, color: colors.textPrimary },
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
    playerMetaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4, marginTop: spacing.xxs },
    playerMeta: { fontSize: fontSize.sm, color: colors.textMuted },
    compactStats: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.sm + spacing.xxs, rowGap: spacing.xs, marginTop: spacing.sm },
    compactStat: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs },
    compactStatLabel: {
        fontSize: 10,
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
    gamesLeftText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.textMuted },
    statsGrid: {
        width: 10 * 54,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexShrink: 0,
    },
    statCell: {
        width: 54,
        textAlign: 'right',
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
        color: colors.textSecondary,
    },
    statCellPrimary: {
        color: colors.primaryDark,
        fontWeight: fontWeight.extrabold,
    },
    statusBadge: {
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: radii.sm,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        width: 90,
        alignItems: 'center',
    },
    statusBadgeNarrow: { width: 'auto', minWidth: 40, alignSelf: 'flex-start', marginTop: 2 },
    statusBadgeMe: { backgroundColor: colors.successLight },
    statusBadgeWaiver: { backgroundColor: colors.infoLight },
    statusBadgeFA: { backgroundColor: colors.bgMuted },
    statusBadgeText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textMuted },
    statusBadgeTextMe: { color: colors.successDark },
    statusBadgeTextWaiver: { color: uiColors.waiverText },
})
