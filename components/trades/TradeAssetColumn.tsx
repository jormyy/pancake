import { orderTradeAssets, tradeRosterAssetOrder } from '@/lib/trade-assets'
import { AssetSelectionRow, LockedAssetNotice } from '@/components/roster/LockedAssetNotice'
import { type AssetLock } from '@/lib/locked-assets'
import { useScreenView } from '@/hooks/use-screen-view'
import { screenScope } from '@/lib/cache/screen-scope'
import type { RosterView } from '@/lib/cache/view-types'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import { pickLabel } from '@/lib/picks'
import { TradePlayerLink } from '@/components/trades/TradePlayerLink'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { View, Text, StyleSheet } from 'react-native'


import { colors, componentTokens, controlSize, fontWeight, radii, spacing, textStyles, typeScale } from '@/constants/tokens'
import { yearShort } from '@/lib/format'
import { getEligiblePositions } from '@/lib/players'
import { playerSeasonContextText } from '@/lib/player-context'
import type { RosterPlayer } from '@/lib/roster'
import { readTradeAssetLocks, type TradePickItem } from '@/lib/trades'

function PlayerRow({
    player,
    avgFpts,
    avgMinutes,
    selected,
    blocked,
    locks,
    checking,
    onToggle,
    testID,
}: {
    player: RosterPlayer
    avgFpts?: number
    avgMinutes?: number | null
    selected: boolean
    blocked: boolean
    locks: AssetLock[]
    checking: boolean
    onToggle: () => void
    testID?: string
}) {
    const p = player.players
    const positions = getEligiblePositions(p)
    const disabled = checking || locks.length > 0 || blocked && !selected
    const statText = playerSeasonContextText({
        yearsExp: p.years_exp,
        avgFantasyPoints: avgFpts ?? null,
        avgMinutesPlayed: avgMinutes ?? null,
    })

    return (
        <View style={[styles.playerRow, selected && styles.playerRowSelected]}>
            <TradePlayerLink compact showTags playerId={p.id} name={p.display_name} nbaId={p.nba_id} team={p.nba_team} positions={positions}
                birthdate={p.birthdate} yearsExp={p.years_exp} careerGames={p.career_regular_season_games} injuryStatus={p.injury_status}
                stats={<Text style={styles.playerContext} numberOfLines={1}>{blocked && !selected ? 'Already routed' : statText}</Text>} />
            <LockedAssetNotice locks={locks} />
            <AssetSelectionRow locks={locks} style={[styles.playerAction, disabled && styles.playerActionDisabled]}
                onPress={onToggle} disabled={disabled} accessibilityRole="button"
                accessibilityState={{ selected, disabled }} aria-pressed={selected}
                label={`${selected ? 'Remove' : 'Add'} ${p.display_name} ${selected ? 'from' : 'to'} trade`}
                testID={testID} id={testID}>
                <Text style={styles.playerActionText} numberOfLines={1}>{selected ? 'Remove' : 'Add'}</Text>
            </AssetSelectionRow>
        </View>
    )
}

function PickRow({
    pick,
    selected,
    blocked,
    locks,
    checking,
    onToggle,
    testID,
}: {
    pick: TradePickItem
    selected: boolean
    blocked: boolean
    locks: AssetLock[]
    checking: boolean
    onToggle: () => void
    testID?: string
}) {
    const action = selected ? 'Remove' : 'Select'
    return (
        <View><AssetSelectionRow locks={locks}
            style={[styles.playerRow, selected && styles.playerRowSelected]}
            onPress={onToggle}
            disabled={checking || locks.length > 0 || blocked && !selected}
            accessibilityRole="button"
            accessibilityState={{ disabled: checking || locks.length > 0 || blocked && !selected }}
            label={`${action} ${pickLabel(pick.seasonYear, pick.round)} pick via ${pick.originalTeamName} for trade`}
            testID={testID}
            id={testID}
        >
            <View style={[styles.pickCircle, selected && styles.pickCircleSelected]}>
                <Text style={styles.pickCircleText}>{yearShort(pick.seasonYear)}</Text>
            </View>
            <View style={styles.playerInfo}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minWidth: 0 }}>
                    <Text style={[styles.playerName, selected && styles.playerNameSelected]} numberOfLines={1}>{pickLabel(pick.seasonYear, pick.round)}</Text>
                    <LockedAssetNotice locks={locks} />
                </View>
                <Text style={styles.playerMeta} numberOfLines={1}>via {pick.originalTeamName}</Text>
                {blocked && !selected ? <Text style={styles.playerContext}>Already routed</Text> : null}
            </View>
            {selected && (
                <View style={styles.removeBadge} aria-hidden>
                    <MaterialIcons name="remove" size={18} color={colors.textWhite} />
                </View>
            )}
        </AssetSelectionRow></View>
    )
}

export function TradeAssetColumn({
    memberId,
    roster,
    picks,
    avgMap,
    avgStatsMap,
    selectedPlayerIds,
    selectedPickIds,
    blockedPlayerIds,
    blockedPickIds,
    onTogglePlayer,
    onTogglePick,
    emptyText,
    testIdPrefix,
}: {
    memberId?: string
    roster: RosterPlayer[]
    picks: TradePickItem[]
    avgMap: Map<string, number>
    avgStatsMap: Map<string, { avg_minutes_played: number | null }>
    selectedPlayerIds: Set<string>
    selectedPickIds: Set<string>
    blockedPlayerIds?: ReadonlySet<string>
    blockedPickIds?: ReadonlySet<string>
    onTogglePlayer: (id: string) => void
    onTogglePick: (id: string) => void
    emptyText: string
    testIdPrefix?: string
}) {
    const { user } = useAuth()
    const { current, currentLeague } = useLeagueContext()
    const ownAssets = memberId === current?.id
    const locksView = useScreenView<RosterView>(ownAssets && user && current && currentLeague
        ? screenScope('roster', currentLeague.id, current.id, {}, user.id) : null)
    const checking = ownAssets && !locksView.data
    const locks = readTradeAssetLocks(locksView.data)
    const locksFor = (kind: AssetLock['assetKind'], id: string) => locks.filter(lock => lock.assetKind === kind && lock.assetId === id)

    return (
        <View style={styles.column}>
            {roster.length === 0 ? (
                <Text style={styles.emptyRowText}>{emptyText}</Text>
            ) : (
                orderTradeAssets(roster, tradeRosterAssetOrder).map((rp) => (
                    <PlayerRow
                        key={rp.id}
                        player={rp}
                        checking={checking}
                        locks={locksFor('player', rp.players.id)}
                        avgFpts={avgMap.get(rp.players.id)}
                        avgMinutes={avgStatsMap.get(rp.players.id)?.avg_minutes_played}
                        selected={selectedPlayerIds.has(rp.players.id)}
                        blocked={blockedPlayerIds?.has(rp.players.id) ?? false}
                        onToggle={() => onTogglePlayer(rp.players.id)}
                        testID={testIdPrefix ? `${testIdPrefix}-player-${rp.players.id}` : undefined}
                    />
                ))
            )}

            {picks.length > 0 ? (
                <>
                    <Text style={styles.subSectionLabel}>DRAFT PICKS</Text>
                    {orderTradeAssets(picks).map((pick) => (
                        <PickRow
                            key={pick.pickId}
                            pick={pick}
                            checking={checking}
                            locks={locksFor('pick', pick.pickId)}
                            selected={selectedPickIds.has(pick.pickId)}
                            blocked={blockedPickIds?.has(pick.pickId) ?? false}
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
    column: { width: '100%', minWidth: 0 },
    subSectionLabel: {
        ...textStyles.sectionLabel,
        paddingHorizontal: componentTokens.playerRow.compact.paddingHorizontal,
        paddingTop: spacing.lg,
        paddingBottom: spacing.sm,
    },
    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: componentTokens.playerRow.compact.paddingHorizontal,
        minHeight: componentTokens.playerRow.compact.minHeight,
        paddingVertical: componentTokens.playerRow.compact.paddingVertical,
        gap: componentTokens.playerRow.compact.gap,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    playerAction: { width: controlSize.minTouch + spacing['3xl'], flexShrink: 0, minWidth: controlSize.minTouch, minHeight: controlSize.minTouch, paddingHorizontal: spacing.sm, alignItems: 'center', justifyContent: 'center', borderRadius: radii.md, borderWidth: 1, borderColor: colors.primaryBorder },
    playerActionDisabled: { opacity: 0.5 },
    playerActionText: { ...typeScale.small, fontWeight: fontWeight.semibold, color: colors.primaryDark },
    playerRowSelected: { backgroundColor: colors.primaryLight },
    pickCircle: {
        flexShrink: 0,
        width: controlSize.avatar.md,
        height: controlSize.avatar.md,
        borderRadius: radii.full,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.info,
        justifyContent: 'center',
        alignItems: 'center',
    },
    pickCircleSelected: { backgroundColor: colors.primary },
    pickCircleText: { ...typeScale.small, color: colors.onAccent, fontWeight: fontWeight.bold },
    playerInfo: { flex: 1, minWidth: 0, gap: spacing.xxs },
    playerName: { ...textStyles.rowTitle, flexShrink: 1, minWidth: 0 },
    playerNameSelected: { color: colors.primaryDark },
    playerMeta: { ...textStyles.meta },
    playerContext: { ...typeScale.caption, color: colors.primaryDark, fontWeight: fontWeight.semibold },
    removeBadge: {
        flexShrink: 0,
        width: 24,
        height: 24,
        borderRadius: radii.full,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
        justifyContent: 'center',
        alignItems: 'center',
    },
    emptyRowText: {
        ...typeScale.body,
        paddingHorizontal: componentTokens.playerRow.compact.paddingHorizontal,
        paddingVertical: spacing.lg,
        color: colors.textPlaceholder,
    },
})
