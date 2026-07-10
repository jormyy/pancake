import { Pressable, StyleSheet, Text, View } from 'react-native'
import { memo } from 'react'
import { useRouter } from 'expo-router'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { SectionHeader } from '@/components/SectionHeader'
import { TradeCard } from '@/components/trades/TradeCard'
import type { TradeTabKey } from '@/lib/trade-ui-model'
import { colors, fontSize, fontWeight, INJURY_COLORS, radii, spacing, uiColors } from '@/constants/tokens'
import { playerHeadshotUrl, yearShort } from '@/lib/format'
import { playerEligiblePositions, playerSeasonContextText } from '@/lib/player-context'
import type { RosterPlayer } from '@/lib/roster'
import type { TradeBlockItem, TradePickItem } from '@/lib/trades'
import type { TradeListItem } from '@/lib/trades-screen-model'
import type { TradeVetoMode } from '@/lib/league'

type ItemOf<Type extends TradeListItem['_type']> = Extract<TradeListItem, { _type: Type }>

export const TradeSectionRow = memo(function TradeSectionRow({ item }: { item: ItemOf<'header'> }) {
    return item.label ? <SectionHeader label={item.label} /> : null
})

export const TradeEmptyRow = memo(function TradeEmptyRow({ item }: { item: ItemOf<'empty'> }) {
    return <View style={styles.emptyRow}><Text style={styles.emptyText}>{item.message}</Text></View>
})

export const TradePickRow = memo(function TradePickRow({
    item,
    myTeamName,
}: {
    item: ItemOf<'pick'>
    myTeamName: string
}) {
    const isOwn = item.pick.originalTeamName === myTeamName
    return (
        <View style={styles.pickRow}>
            <View style={styles.pickCircle}><Text style={styles.pickCircleText}>{yearShort(item.pick.seasonYear)}</Text></View>
            <Text style={styles.pickLabel}>Round {item.pick.round}</Text>
            <View style={styles.pickSpacer} />
            <View style={[styles.pickChip, !isOwn && styles.pickChipTraded]}>
                <Text style={styles.pickChipText} numberOfLines={1}>
                    {isOwn ? 'Own pick' : `From ${item.pick.originalTeamName}`}
                </Text>
            </View>
        </View>
    )
})

export const TradeBlockListingRow = memo(function TradeBlockListingRow({
    item,
    myMemberId,
    tab,
    blockBusyId,
    onRemove,
}: {
    item: ItemOf<'blockItem'>
    myMemberId: string
    tab: TradeTabKey
    blockBusyId: string | null
    onRemove: (item: TradeBlockItem) => void | Promise<void>
}) {
    const { push } = useRouter()
    const block = item.item
    const mine = block.memberId === myMemberId
    const label = block.asset.kind === 'player'
        ? block.asset.playerName
        : block.asset.kind === 'pick'
            ? `${block.asset.seasonYear} Round ${block.asset.round} pick`
            : `FAAB $${block.asset.amount}`
    const positions = block.asset.kind === 'player' ? playerEligiblePositions(block.asset) : []
    return (
        <View style={styles.blockRow}>
            {block.asset.kind === 'player' ? (
                <Avatar name={block.asset.playerName} uri={playerHeadshotUrl(block.asset.nbaId) ?? undefined}
                    color={colors.bgMuted} textColor={colors.textSecondary} size={38} />
            ) : null}
            <View style={styles.blockInfo}>
                <Text style={styles.blockTitle}>{label}</Text>
                {block.asset.kind === 'player' ? (
                    <>
                        <View style={styles.blockMetaRow}>
                            <Text style={styles.blockMeta}>{block.teamName}</Text>
                            {block.asset.nbaTeam ? <Text style={styles.blockMeta}>{block.asset.nbaTeam}</Text> : null}
                            {positions.map((position) => <PosTag key={position} position={position} />)}
                            {block.asset.injuryStatus ? <Badge label={block.asset.injuryStatus}
                                color={INJURY_COLORS[block.asset.injuryStatus] ?? colors.textMuted} variant="solid" /> : null}
                        </View>
                        <Text style={styles.blockContext} numberOfLines={1}>{playerSeasonContextText(block.asset)}</Text>
                    </>
                ) : <Text style={styles.blockMeta}>{block.teamName}</Text>}
                {block.note ? <Text style={styles.blockNote}>{block.note}</Text> : null}
            </View>
            {mine && tab === 'leagueBlock' ? (
                <View style={[styles.blockAction, styles.blockActionDisabled]} accessibilityLabel={`${label} is your listing`} accessibilityRole="text">
                    <Text style={styles.blockActionText}>Yours</Text>
                </View>
            ) : mine ? (
                <Pressable style={styles.blockAction} onPress={() => onRemove(block)}
                    disabled={blockBusyId === block.id} accessibilityRole="button"
                    accessibilityLabel={`Remove ${label} from trade block`}>
                    <Text style={styles.blockActionText}>Remove</Text>
                </Pressable>
            ) : (
                <Pressable style={styles.blockAction} onPress={() => push({
                    pathname: '/(modals)/propose-trade',
                    params: {
                        recipientMemberId: block.memberId,
                        requestPlayerId: block.asset.kind === 'player' ? block.asset.playerId : undefined,
                        requestPickId: block.asset.kind === 'pick' ? block.asset.pickId : undefined,
                    },
                })} accessibilityRole="button" accessibilityLabel={`Offer for ${label}`}>
                    <Text style={styles.blockActionText}>Offer</Text>
                </Pressable>
            )}
        </View>
    )
})

export const TradeBlockPlayerRow = memo(function TradeBlockPlayerRow({
    item,
    listed,
    busy,
    blockAvgMap,
    blockAvgStatsMap,
    onList,
}: {
    item: ItemOf<'blockPlayer'>
    listed: boolean
    busy: boolean
    blockAvgMap: Map<string, number>
    blockAvgStatsMap: Map<string, { avg_minutes_played: number | null }>
    onList: (player: RosterPlayer) => void | Promise<void>
}) {
        const player = item.player.players
        const positions = playerEligiblePositions({ position: player.position, eligiblePositions: player.eligible_positions })
        const context = playerSeasonContextText({
            yearsExp: player.years_exp,
            avgFantasyPoints: blockAvgMap.get(player.id) ?? null,
            avgMinutesPlayed: blockAvgStatsMap.get(player.id)?.avg_minutes_played ?? null,
        })
        return (
            <View style={styles.blockRow}>
                <Avatar name={player.display_name} uri={playerHeadshotUrl(player.nba_id) ?? undefined}
                    color={colors.bgMuted} textColor={colors.textSecondary} size={38} />
                <View style={styles.blockInfo}>
                    <Text style={styles.blockTitle}>{player.display_name}</Text>
                    <View style={styles.blockMetaRow}>
                        {player.nba_team ? <Text style={styles.blockMeta}>{player.nba_team}</Text> : null}
                        {positions.map((position) => <PosTag key={position} position={position} />)}
                        {player.injury_status ? <Badge label={player.injury_status}
                            color={INJURY_COLORS[player.injury_status] ?? colors.textMuted} variant="solid" /> : null}
                    </View>
                    <Text style={styles.blockContext} numberOfLines={1}>{context}</Text>
                </View>
                <Pressable style={[styles.blockAction, listed && styles.blockActionDisabled]}
                    onPress={() => onList(item.player)} disabled={listed || busy}
                    accessibilityRole="button" accessibilityLabel={`${listed ? 'Listed' : 'List'} ${player.display_name} on trade block`}
                    accessibilityState={{ disabled: listed || busy }}>
                    <Text style={styles.blockActionText}>{listed ? 'Listed' : 'List'}</Text>
                </Pressable>
            </View>
        )
})

export const TradeBlockPickRow = memo(function TradeBlockPickRow({
    item,
    listed,
    busy,
    onList,
}: {
    item: ItemOf<'blockPick'>
    listed: boolean
    busy: boolean
    onList: (pick: TradePickItem) => void | Promise<void>
}) {
    return (
        <View style={styles.blockRow}>
            <View style={styles.blockInfo}>
                <Text style={styles.blockTitle}>{item.pick.seasonYear} Round {item.pick.round}</Text>
                <Text style={styles.blockMeta}>via {item.pick.originalTeamName}</Text>
            </View>
            <Pressable style={[styles.blockAction, listed && styles.blockActionDisabled]}
                onPress={() => onList(item.pick)} disabled={listed || busy}
                accessibilityRole="button" accessibilityLabel={`${listed ? 'Listed' : 'List'} ${item.pick.seasonYear} round ${item.pick.round} pick on trade block`}
                accessibilityState={{ disabled: listed || busy }}>
                <Text style={styles.blockActionText}>{listed ? 'Listed' : 'List'}</Text>
            </Pressable>
        </View>
    )
})

export const TradeOfferRow = memo(function TradeOfferRow({
    item,
    myMemberId,
    leagueId,
    rosterSize,
    tab,
    tradeVetoMode,
    isCommissioner,
    onAction,
}: {
    item: ItemOf<'trade'>
    myMemberId: string
    leagueId: string
    rosterSize: number
    tab: TradeTabKey
    tradeVetoMode: TradeVetoMode
    isCommissioner: boolean
    onAction: () => void | Promise<void>
}) {
    return <TradeCard trade={item.trade} myMemberId={myMemberId} leagueId={leagueId}
        rosterSize={rosterSize} tab={tab} tradeVetoMode={tradeVetoMode}
        isCommissioner={isCommissioner} onAction={onAction} />
})

const styles = StyleSheet.create({
    emptyRow: { minHeight: 56, justifyContent: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.md },
    emptyText: { fontSize: fontSize.sm, color: colors.textMuted },
    pickRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg, gap: spacing.lg, width: '100%', maxWidth: 760 },
    pickCircle: { width: 44, height: 44, borderRadius: 22, borderCurve: 'continuous', backgroundColor: uiColors.neutralSolid, justifyContent: 'center', alignItems: 'center' },
    pickCircleText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.sm },
    pickLabel: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary, minWidth: 84 },
    pickSpacer: { flex: 1 },
    pickChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radii.lg, borderCurve: 'continuous', backgroundColor: colors.bgMuted },
    pickChipTraded: { backgroundColor: colors.primaryLight },
    pickChipText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    blockRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingHorizontal: spacing.xl, paddingVertical: spacing.md },
    blockInfo: { flex: 1, minWidth: 0, gap: spacing.xxs },
    blockTitle: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textPrimary },
    blockMetaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
    blockMeta: { fontSize: fontSize.sm, color: colors.textMuted },
    blockContext: { fontSize: fontSize.xs, color: colors.primaryDark, fontWeight: fontWeight.bold },
    blockNote: { fontSize: fontSize.sm, color: colors.textSecondary },
    blockAction: { minWidth: 72, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radii.md, borderCurve: 'continuous', borderWidth: 1, borderColor: colors.primary, paddingHorizontal: spacing.md },
    blockActionDisabled: { borderColor: colors.borderLight, backgroundColor: colors.bgMuted },
    blockActionText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
})
