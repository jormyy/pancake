import { PendingMutationBadge } from '@/components/PendingMutationBadge'
import { Badge } from '@/components/ui/Badge'
import { StatCell } from '@/components/ui/StatCell'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { View, Text, StyleSheet, Pressable } from 'react-native'
import { memo } from 'react'
import { claimProcessWeekdayLabel } from '@/lib/waivers'
import { PlayerRow, getEligiblePositions } from '@/lib/players'
import { formatPoints } from '@/lib/format'
import { OwnedEntry } from '@/lib/roster'
import { colors, componentTokens, controlSize, fontWeight, radii, spacing, table, textStyles, uiColors } from '@/constants/tokens'


import { MotionPressable, MotionView } from '@/components/Motion'
import { blockedActionProps } from '@/lib/a11y'
import {
    formatProjectionGame,
} from '@/lib/projections'

function PlayerSearchItemImpl({
    item,
    currentMemberId,
    ownedMap,
    waiverIds,
    waiverClearsAt = null,
    claimPending = false,
    isAdding,
    addDisabled = false,
    showStats = false,
    showCompactStats = true,
    statMode = 'season',
    animate = true,
    addBlockedReason = null,
    onAdd,
    onPress,
    onPrepare,
}: {
    item: PlayerRow
    currentMemberId: string | undefined
    ownedMap: Map<string, OwnedEntry>
    waiverIds: Set<string>
    waiverClearsAt?: string | null
    claimPending?: boolean
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
    onPrepare?: (player: PlayerRow) => void
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
    const compactStats = stats.filter(stat => stat.label !== 'FP' && stat.label !== 'MIN').slice(0, 7)
    const denseProjectionRow = statMode === 'projection' && !showStats

    const statusBadge = currentMemberId && (!isFA || showStats) ? (
        <Badge size="ownership" variant="solid"
            color={showStats ? 'transparent' : isMe ? colors.successLight : isWaiver ? colors.infoLight : colors.bgMuted}
            textColor={isMe ? colors.successDark : isWaiver ? uiColors.waiverText : colors.textMuted}
            style={[styles.statusBadge, !showStats && styles.statusBadgeNarrow]}
            label={isMe ? 'Mine' : isOther ? owned!.teamName : isWaiver ? `W · ${claimProcessWeekdayLabel(waiverClearsAt)}` : 'FA'}
        />
    ) : null

    const summary = showStats ? <View style={styles.statsGrid}>
        {stats.map(stat => <StatCell key={stat.label} value={stat.label === 'FP' || stat.label === 'MIN' ? stat.value ?? 0 : stat.value} highlight={stat.highlight} integer={stat.integer} />)}
    </View> : <View style={styles.playerMetaRow}>
        <Text style={styles.playerMeta}>
            <Text style={[styles.playerMetaScore, item.playing_now && styles.liveLabel]}>
                {formatPoints(stats[0]?.value ?? 0)} {item.playing_now ? 'LIVE' : 'FP'}
            </Text>
            {` · ${formatPoints(stats.find(stat => stat.label === 'MIN')?.value ?? 0)} mins`}
            {denseProjectionRow && projectionGame ? ` · ${projectionGame}` : null}
            {showCompactStats ? compactStats.map(stat => ` · ${stat.label} ${formatPoints(stat.value)}`).join('') : null}
        </Text>
        {statusBadge}
    </View>

    const content = (
        <>
            <Pressable
                style={[styles.playerCard, !showStats && styles.playerCardNarrow, denseProjectionRow && styles.playerCardDense]}
                onPress={() => onPress(item)}
                onTouchStart={onPrepare ? () => onPrepare(item) : undefined}
                accessibilityRole="button"
                accessibilityLabel={`Open ${item.display_name}`}
            >
                <PendingMutationBadge rowId={item.id} />
                <PlayerRowContent compact={!showStats} name={item.display_name} nbaId={item.nba_id} team={item.nba_team} positions={getEligiblePositions(item)}
                    yearsExp={item.years_exp} careerGames={item.career_regular_season_games} injuryStatus={item.injury_status} onTaxi={owned?.isOnTaxi} metadata={showStats ? statusBadge : undefined} stats={summary} />

            </Pressable>
            <View style={styles.addCol}>
                {canAdd ? (
                    <MotionPressable
                        style={styles.addTarget}
                        onPress={() => onAdd(item)}
                        disabled={isAdding || addDisabled}
                        accessibilityRole="button"
                        accessibilityLabel={`${claimPending ? 'View claim for' : 'Claim'} ${item.display_name}`}
                        {...blockedActionProps(blockedReason, isAdding || addDisabled)}
                    >
                        <View style={[styles.addBtn, isWaiver && styles.addBtnWaiver, blockedReason ? styles.addBtnBlocked : null]}>
                            <MaterialIcons
                                name="schedule"
                                size={controlSize.icon.md}
                                color={blockedReason ? colors.textPlaceholder : isWaiver ? uiColors.waiverText : colors.primaryDark}
                            />
                        </View>
                    </MotionPressable>
                ) : null}
            </View>
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

const ADD_COL_W = componentTokens.playerRow.actionWidth

const styles = StyleSheet.create({
    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.sm,
        minHeight: componentTokens.playerRow.standard.minHeight,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    addCol: { width: ADD_COL_W, alignItems: 'center' },
    addTarget: { width: ADD_COL_W, height: controlSize.minTouch, alignItems: 'center', justifyContent: 'center' },
    addBtn: {
        width: spacing['4xl'],
        height: spacing['4xl'],
        borderRadius: radii.full,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primaryLight,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        alignItems: 'center',
        justifyContent: 'center',
    },
    addBtnWaiver: { backgroundColor: colors.infoLight, borderColor: colors.info, borderWidth: 1 },
    addBtnBlocked: { backgroundColor: colors.bgMuted, borderColor: colors.borderLight },
    playerCard: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: spacing.lg,
        paddingVertical: componentTokens.playerRow.standard.paddingVertical,
        paddingLeft: spacing.sm,
        gap: spacing.md,
    },
    playerCardNarrow: { paddingRight: spacing.xs, paddingVertical: componentTokens.playerRow.compact.paddingVertical, minHeight: controlSize.minTouch },
    playerCardDense: { paddingVertical: spacing.xs, paddingRight: spacing.xs, gap: spacing.md },
    playerMetaScore: { fontWeight: fontWeight.bold, color: colors.primaryDark },
    playerMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minWidth: 0 },
    playerMeta: { ...textStyles.meta, flex: 1, minWidth: 0, fontVariant: ['tabular-nums'] },
    liveLabel: { color: colors.success, fontWeight: fontWeight.bold },
    statsGrid: {
        alignSelf: 'flex-end',
        width: componentTokens.playerRow.statCount * table.statColWidth,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexShrink: 0,
    },
    statusBadge: { width: componentTokens.badge.ownership.width },
    statusBadgeNarrow: { width: 'auto', paddingHorizontal: spacing.xs, maxWidth: componentTokens.badge.ownership.maxCompactWidth },
})
