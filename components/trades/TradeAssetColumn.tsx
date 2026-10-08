import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { colors, fontSize, fontWeight, radii, spacing, textStyles, uiColors, INJURY_COLORS } from '@/constants/tokens'
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
    destinationLabel,
    onToggle,
    testID,
}: {
    player: RosterPlayer
    avgFpts?: number
    avgMinutes?: number | null
    selected: boolean
    destinationLabel?: string | null
    onToggle: () => void
    testID?: string
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
            testID={testID}
            id={testID}
        >
            <Avatar
                name={p.display_name}
                uri={playerHeadshotUrl(p.nba_id) ?? undefined}
                color={selected ? colors.primary : colors.bgMuted}
                textColor={selected ? colors.textWhite : colors.textSecondary}
                size={36}
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
                {selected && destinationLabel ? (
                    <Text style={styles.routeMeta} numberOfLines={1}>
                        To {destinationLabel}
                    </Text>
                ) : null}
            </View>
            {selected && (
                <View style={styles.removeBadge} aria-hidden>
                    <MaterialIcons name="remove" size={18} color={colors.textWhite} />
                </View>
            )}
        </Pressable>
    )
}

function PickRow({
    pick,
    selected,
    destinationLabel,
    onToggle,
    testID,
}: {
    pick: TradePickItem
    selected: boolean
    destinationLabel?: string | null
    onToggle: () => void
    testID?: string
}) {
    const action = selected ? 'Remove' : 'Select'
    return (
        <Pressable
            style={[styles.playerRow, selected && styles.playerRowSelected]}
            onPress={onToggle}
            accessibilityRole="button"
            accessibilityLabel={`${action} ${pick.seasonYear} round ${pick.round} pick via ${pick.originalTeamName} for trade`}
            testID={testID}
            id={testID}
        >
            <View style={[styles.pickCircle, selected && styles.pickCircleSelected]}>
                <Text style={styles.pickCircleText}>{yearShort(pick.seasonYear)}</Text>
            </View>
            <View style={styles.playerInfo}>
                <Text style={[styles.playerName, selected && styles.playerNameSelected]}>
                    {pick.seasonYear} Round {pick.round}
                </Text>
                <Text style={styles.playerMeta}>via {pick.originalTeamName}</Text>
                {selected && destinationLabel ? (
                    <Text style={styles.routeMeta} numberOfLines={1}>
                        To {destinationLabel}
                    </Text>
                ) : null}
            </View>
            {selected && (
                <View style={styles.removeBadge} aria-hidden>
                    <MaterialIcons name="remove" size={18} color={colors.textWhite} />
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
    playerDestinationLabel,
    pickDestinationLabel,
    onTogglePlayer,
    onTogglePick,
    emptyText,
    testIdPrefix,
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
    playerDestinationLabel?: (id: string) => string | null
    pickDestinationLabel?: (id: string) => string | null
    onTogglePlayer: (id: string) => void
    onTogglePick: (id: string) => void
    emptyText: string
    testIdPrefix?: string
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
                        destinationLabel={playerDestinationLabel?.(rp.players.id)}
                        onToggle={() => onTogglePlayer(rp.players.id)}
                        testID={testIdPrefix ? `${testIdPrefix}-player-${rp.players.id}` : undefined}
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
                            destinationLabel={pickDestinationLabel?.(pick.pickId)}
                            onToggle={() => onTogglePick(pick.pickId)}
                            testID={testIdPrefix ? `${testIdPrefix}-pick-${pick.pickId}` : undefined}
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
    columnTitle: { ...textStyles.sectionLabel, color: colors.textPrimary },
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
    columnCountText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.onAccent },
    subSectionLabel: {
        ...textStyles.sectionLabel,
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.lg,
        paddingBottom: spacing.sm,
    },
    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        gap: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    playerRowSelected: { backgroundColor: colors.primaryLight },
    pickCircle: {
        width: 36,
        height: 36,
        borderRadius: radii.full,
        borderCurve: 'continuous' as const,
        backgroundColor: uiColors.accentPick,
        justifyContent: 'center',
        alignItems: 'center',
    },
    pickCircleSelected: { backgroundColor: colors.primary },
    pickCircleText: { color: colors.onAccent, fontWeight: fontWeight.bold, fontSize: fontSize['2sm'] },
    playerInfo: { flex: 1, minWidth: 0, gap: spacing.xxs },
    playerName: { ...textStyles.rowTitle },
    playerNameSelected: { color: colors.primaryDark },
    playerMetaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
    playerMeta: { ...textStyles.meta },
    playerContext: { fontSize: fontSize.xs, color: colors.primaryDark, fontWeight: fontWeight.semibold },
    routeMeta: { fontSize: fontSize.xs, color: colors.textSecondary, fontWeight: fontWeight.semibold },
    removeBadge: {
        width: 24,
        height: 24,
        borderRadius: radii.full,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
        justifyContent: 'center',
        alignItems: 'center',
    },
    emptyRowText: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        color: colors.textPlaceholder,
        fontSize: fontSize.md,
    },
})
