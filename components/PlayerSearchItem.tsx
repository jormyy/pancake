import { View, Text, StyleSheet, ActivityIndicator, Image, Pressable } from 'react-native'
import { useState } from 'react'
import { PlayerRow, getEligiblePositions } from '@/lib/players'
import { playerHeadshotUrl } from '@/lib/format'
import { OwnedEntry } from '@/lib/roster'
import { getPositionColor } from '@/constants/positions'
import { INJURY_COLORS, colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { MotionPressable, MotionView } from '@/components/Motion'

export function PlayerSearchItem({
    item,
    currentMemberId,
    ownedMap,
    waiverIds,
    adding,
    gamesLeft,
    showStats = false,
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
    const stats = [
        { label: 'FP', value: item.avg_fantasy_points ?? item.avg_points, highlight: true },
        { label: 'PTS', value: item.avg_points },
        { label: 'REB', value: item.avg_rebounds },
        { label: 'AST', value: item.avg_assists },
        { label: 'STL', value: item.avg_steals },
        { label: 'BLK', value: item.avg_blocks },
        { label: '3PM', value: item.avg_three_pointers_made },
        { label: 'TO', value: item.avg_turnovers },
        { label: 'GP', value: item.games_played, integer: true },
    ]

    return (
        <MotionView style={styles.playerRow} preset="rise">
            <View style={styles.addCol}>
                {canAdd ? (
                    <MotionPressable
                        style={styles.addBtn}
                        onPress={() => onAdd(item)}
                        disabled={isAdding}
                        accessibilityRole="button"
                        accessibilityLabel={`Add ${item.display_name}`}
                        accessibilityState={{ disabled: isAdding, busy: isAdding }}
                        hitSlop={8}
                        pressedScale={0.88}
                    >
                        {isAdding
                            ? <ActivityIndicator size="small" color={colors.primary} />
                            : <Text style={styles.addBtnText}>+</Text>}
                    </MotionPressable>
                ) : null}
            </View>

            <Pressable
                style={styles.playerCard}
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={`Open ${item.display_name}`}
            >
                {headshotUri && !headshotError ? (
                    <Image
                        source={{ uri: headshotUri }}
                        style={styles.headshot}
                        onError={() => setHeadshotError(true)}
                    />
                ) : (
                    <Avatar
                        name={item.display_name}
                        color={getPositionColor(item.eligible_positions?.[0] ?? item.position)}
                    />
                )}

                <View style={styles.playerInfo}>
                    <Text style={styles.playerName}>{item.display_name}</Text>
                    <View style={styles.playerMetaRow}>
                        {item.nba_team && <Text style={styles.playerMeta}>{item.nba_team}</Text>}
                        {getEligiblePositions(item).map((pos: string) => <PosTag key={pos} position={pos} />)}
                        {item.years_exp != null && (
                            <Text style={[styles.gamesLeftText, item.years_exp === 0 && { color: colors.success }]}>
                                {item.years_exp === 0 ? 'Rookie' : `Yr ${item.years_exp + 1}`}
                            </Text>
                        )}
                        {item.nba_team != null && (
                            <Text style={styles.gamesLeftText}>
                                {gamesLeft.get(item.nba_team) ?? 0}G left
                            </Text>
                        )}
                        {item.injury_status ? (
                            <Badge
                                label={item.injury_status}
                                color={INJURY_COLORS[item.injury_status] ?? colors.textMuted}
                                variant="solid"
                            />
                        ) : null}
                    </View>
                </View>

                {currentMemberId ? (
                    <View style={[
                        styles.statusBadge,
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
        </MotionView>
    )
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
    const display = value == null ? '—' : integer ? String(Math.round(Number(value))) : Number(value).toFixed(1)
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
    addCol: { width: 36, alignItems: 'center' },
    addBtn: {
        width: 28,
        height: 28,
        borderRadius: 14,
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
    headshot: {
        width: 44,
        height: 44,
        borderRadius: 22,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    playerInfo: { flex: 1 },
    playerName: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    playerMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.xxs },
    playerMeta: { fontSize: fontSize.sm, color: colors.textMuted },
    gamesLeftText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.textMuted },
    statsGrid: {
        width: 9 * 54,
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
        backgroundColor: palette.gray250,
        width: 90,
        alignItems: 'center',
    },
    statusBadgeMe: { backgroundColor: palette.green300 },
    statusBadgeWaiver: { backgroundColor: palette.purple100 },
    statusBadgeFA: { backgroundColor: palette.gray250 },
    statusBadgeText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textPlaceholder },
    statusBadgeTextMe: { color: palette.green800 },
    statusBadgeTextWaiver: { color: palette.purple600 },
})
