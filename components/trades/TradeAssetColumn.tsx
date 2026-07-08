import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { colors, fontSize, fontWeight, radii, spacing, uiColors, INJURY_COLORS } from '@/constants/tokens'
import { getPositionColor } from '@/constants/positions'
import { playerHeadshotUrl, yearShort } from '@/lib/format'
import { getEligiblePositions } from '@/lib/players'
import { playerSeasonContextText } from '@/lib/player-context'
import type { RosterPlayer } from '@/lib/roster'
import type { TradePickItem } from '@/lib/trades'

function PlayerRow({
    player,
    avgFpts,
    avgMinutes,
    selected,
    onToggle,
}: {
    player: RosterPlayer
    avgFpts?: number
    avgMinutes?: number | null
    selected: boolean
    onToggle: () => void
}) {
    const p = player.players
    const positions = getEligiblePositions(p)
    const action = selected ? 'Remove' : 'Select'
    const statText = playerSeasonContextText({
        yearsExp: p.years_exp,
        avgFantasyPoints: avgFpts ?? null,
        avgMinutesPlayed: avgMinutes ?? null,
    })

    return (
        <Pressable
            style={[styles.playerRow, selected && styles.playerRowSelected]}
            onPress={onToggle}
            accessibilityRole="button"
            accessibilityLabel={`${action} ${p.display_name} for trade`}
        >
            <Avatar
                name={p.display_name}
                uri={playerHeadshotUrl(p.nba_id) ?? undefined}
                color={selected ? colors.primary : getPositionColor(positions[0] ?? p.position, colors.primaryDark)}
                size={40}
            />
            <View style={styles.playerInfo}>
                <Text style={[styles.playerName, selected && styles.playerNameSelected]}>
                    {p.display_name}
                </Text>
                <View style={styles.playerMetaRow}>
                    {p.nba_team ? <Text style={styles.playerMeta}>{p.nba_team}</Text> : null}
                    {positions.map((pos) => <PosTag key={pos} position={pos} />)}
                    {p.injury_status ? (
                        <Badge
                            label={p.injury_status}
                            color={INJURY_COLORS[p.injury_status] ?? colors.textMuted}
                            variant="solid"
                        />
                    ) : null}
                    {player.is_on_ir ? <Badge label="IR" color={colors.textMuted} variant="soft" /> : null}
                </View>
                <Text style={styles.playerContext} numberOfLines={1}>
                    {statText}
                </Text>
            </View>
            {selected && (
                <View style={styles.checkBadge}>
                    <Text style={styles.checkBadgeText}>+</Text>
                </View>
            )}
        </Pressable>
    )
}

function PickRow({
    pick,
    selected,
    onToggle,
}: {
    pick: TradePickItem
    selected: boolean
    onToggle: () => void
}) {
    const action = selected ? 'Remove' : 'Select'
    return (
        <Pressable
            style={[styles.playerRow, selected && styles.playerRowSelected]}
            onPress={onToggle}
            accessibilityRole="button"
            accessibilityLabel={`${action} ${pick.seasonYear} round ${pick.round} pick via ${pick.originalTeamName} for trade`}
        >
            <View style={[styles.pickCircle, selected && styles.pickCircleSelected]}>
                <Text style={styles.pickCircleText}>{yearShort(pick.seasonYear)}</Text>
            </View>
            <View style={styles.playerInfo}>
                <Text style={[styles.playerName, selected && styles.playerNameSelected]}>
                    {pick.seasonYear} Round {pick.round}
                </Text>
                <Text style={styles.playerMeta}>via {pick.originalTeamName}</Text>
            </View>
            {selected && (
                <View style={styles.checkBadge}>
                    <Text style={styles.checkBadgeText}>+</Text>
                </View>
            )}
        </Pressable>
    )
}

export function TradeAssetColumn({
    title,
    subtitle,
    side,
    twoColumn,
    roster,
    picks,
    avgMap,
    avgStatsMap,
    selectedPlayerIds,
    selectedPickIds,
    onTogglePlayer,
    onTogglePick,
    emptyText,
}: {
    title: string
    subtitle: string
    side: 'give' | 'receive'
    twoColumn: boolean
    roster: RosterPlayer[]
    picks: TradePickItem[]
    avgMap: Map<string, number>
    avgStatsMap: Map<string, { avg_minutes_played: number | null }>
    selectedPlayerIds: Set<string>
    selectedPickIds: Set<string>
    onTogglePlayer: (id: string) => void
    onTogglePick: (id: string) => void
    emptyText: string
}) {
    const selectedCount =
        roster.filter((rp) => selectedPlayerIds.has(rp.players.id)).length +
        picks.filter((p) => selectedPickIds.has(p.pickId)).length

    return (
        <View style={[styles.column, !twoColumn && styles.columnStacked]}>
            <View style={styles.columnHeader}>
                <View style={styles.flex1}>
                    <Text style={[styles.columnTitle, side === 'receive' && styles.columnTitleReceive]}>{title}</Text>
                    <Text style={styles.columnSubtitle} numberOfLines={1}>{subtitle}</Text>
                </View>
                {selectedCount > 0 ? (
                    <View style={[styles.columnCount, side === 'receive' && styles.columnCountReceive]}>
                        <Text style={styles.columnCountText}>{selectedCount}</Text>
                    </View>
                ) : null}
            </View>

            {roster.length === 0 ? (
                <Text style={styles.emptyRowText}>{emptyText}</Text>
            ) : (
                roster.map((rp) => (
                    <PlayerRow
                        key={rp.id}
                        player={rp}
                        avgFpts={avgMap.get(rp.players.id)}
                        avgMinutes={avgStatsMap.get(rp.players.id)?.avg_minutes_played}
                        selected={selectedPlayerIds.has(rp.players.id)}
                        onToggle={() => onTogglePlayer(rp.players.id)}
                    />
                ))
            )}

            {picks.length > 0 ? (
                <>
                    <Text style={styles.subSectionLabel}>DRAFT PICKS</Text>
                    {picks.map((pick) => (
                        <PickRow
                            key={pick.pickId}
                            pick={pick}
                            selected={selectedPickIds.has(pick.pickId)}
                            onToggle={() => onTogglePick(pick.pickId)}
                        />
                    ))}
                </>
            ) : null}
        </View>
    )
}

const styles = StyleSheet.create({
    column: { flex: 1, minWidth: 0 },
    columnStacked: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', width: '100%' },
    columnHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.xl,
        paddingTop: spacing['2xl'],
        paddingBottom: spacing.md,
    },
    flex1: { flex: 1, minWidth: 0 },
    columnTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: colors.textPrimary, letterSpacing: 0 },
    columnTitleReceive: { color: colors.primaryDark },
    columnSubtitle: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.xxs, fontWeight: fontWeight.semibold },
    columnCount: {
        minWidth: 22,
        height: 22,
        paddingHorizontal: spacing.sm,
        borderRadius: radii.full,
        backgroundColor: uiColors.neutralSolid,
        alignItems: 'center',
        justifyContent: 'center',
    },
    columnCountReceive: { backgroundColor: colors.primary },
    columnCountText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textWhite },
    subSectionLabel: {
        fontSize: 10,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
        letterSpacing: 0,
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.lg,
        paddingBottom: spacing.sm,
    },
    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    playerRowSelected: { backgroundColor: colors.primaryLight },
    pickCircle: {
        width: 40,
        height: 40,
        borderRadius: 20,
        borderCurve: 'continuous' as const,
        backgroundColor: uiColors.accentPick,
        justifyContent: 'center',
        alignItems: 'center',
    },
    pickCircleSelected: { backgroundColor: colors.primary },
    pickCircleText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 12 },
    playerInfo: { flex: 1, minWidth: 0, gap: 2 },
    playerName: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    playerNameSelected: { color: colors.primaryDark },
    playerMetaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
    playerMeta: { fontSize: 12, color: colors.textMuted },
    playerContext: { fontSize: 11, color: colors.primaryDark, fontWeight: fontWeight.bold },
    checkBadge: {
        width: 24,
        height: 24,
        borderRadius: 12,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
        justifyContent: 'center',
        alignItems: 'center',
    },
    checkBadgeText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.lg, lineHeight: 22 },
    emptyRowText: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        color: colors.textPlaceholder,
        fontSize: fontSize.md,
    },
})
