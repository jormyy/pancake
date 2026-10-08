import { Pressable, StyleSheet, Text, View } from 'react-native'
import { memo } from 'react'
import { useRouter } from 'expo-router'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { TradeCard } from '@/components/trades/TradeCard'
import type { TradeTabKey } from '@/lib/trade-ui-model'
import { colors, fontSize, fontWeight, INJURY_COLORS, radii, spacing, textStyles } from '@/constants/tokens'
import { playerHeadshotUrl } from '@/lib/format'
import { playerEligiblePositions, playerSeasonContextText } from '@/lib/player-context'
import type { RosterPlayer } from '@/lib/roster'
import type { Trade, TradeBlockItem, TradePickItem } from '@/lib/trades'
import type { TradeListItem } from '@/lib/trades-screen-model'
import type { TradeVetoMode } from '@/lib/league'

type ItemOf<Type extends TradeListItem['_type']> = Extract<TradeListItem, { _type: Type }>

export const TradeSectionRow = memo(function TradeSectionRow({ item }: { item: ItemOf<'header'> }) {
    if (!item.label) return null
    return (
        <View style={styles.sectionRow} role="heading" aria-level={2} accessibilityRole="header" accessibilityLabel={item.label}>
            <Text style={styles.sectionText}>{item.label}</Text>
        </View>
    )
})

export const TradeEmptyRow = memo(function TradeEmptyRow({ item }: { item: ItemOf<'empty'> }) {
    return <View style={styles.emptyRow}><Text style={styles.emptyText}>{item.message}</Text></View>
})

export const TradeBlockListingRow = memo(function TradeBlockListingRow({
    item,
    myMemberId,
    tab,
    blockBusyId,
    tile = false,
    onRemove,
}: {
    item: ItemOf<'blockItem'>
    myMemberId: string
    tab: TradeTabKey
    blockBusyId: string | null
    tile?: boolean
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
        <View style={[styles.blockRow, tile && styles.tile]}>
            {block.asset.kind === 'player' ? (
                <Avatar name={block.asset.playerName} uri={playerHeadshotUrl(block.asset.nbaId) ?? undefined}
                    color={colors.bgMuted} textColor={colors.textSecondary} size={36} />
            ) : (
                <View style={styles.pickBadge}><Text style={styles.pickBadgeText}>{block.asset.kind === 'pick' ? `R${block.asset.round}` : '$'}</Text></View>
            )}
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
                {block.note ? <Text style={styles.blockNote} numberOfLines={2}>“{block.note}”</Text> : null}
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
    tile = false,
    onList,
}: {
    item: ItemOf<'blockPlayer'>
    listed: boolean
    busy: boolean
    tile?: boolean
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
        <View style={[styles.blockRow, tile && styles.tile]}>
            <Avatar name={player.display_name} uri={playerHeadshotUrl(player.nba_id) ?? undefined}
                color={colors.bgMuted} textColor={colors.textSecondary} size={36} />
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
    tile = false,
    myTeamName,
    onList,
}: {
    item: ItemOf<'blockPick'>
    myTeamName: string
    listed: boolean
    busy: boolean
    tile?: boolean
    onList: (pick: TradePickItem) => void | Promise<void>
}) {
    return (
        <View style={[styles.blockRow, tile && styles.tile]}>
            <View style={styles.pickBadge}><Text style={styles.pickBadgeText}>R{item.pick.round}</Text></View>
            <View style={styles.blockInfo}>
                <Text style={styles.blockTitle}>{item.pick.seasonYear} Round {item.pick.round}</Text>
                <Text style={styles.blockMeta}>
                    {item.pick.originalTeamName === myTeamName ? 'Own pick' : `via ${item.pick.originalTeamName}`}
                </Text>
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
    tab,
    tradeVetoMode,
    isCommissioner,
    acting,
    onAccept,
    onReject,
    onVeto,
    onWithdraw,
    onAnalyze,
    selected = false,
    brief = false,
    onOpen,
}: {
    item: ItemOf<'trade'>
    myMemberId: string
    tab: TradeTabKey
    tradeVetoMode: TradeVetoMode
    isCommissioner: boolean
    acting: boolean
    onAccept: (trade: ItemOf<'trade'>['trade']) => void
    onReject: (tradeId: string) => void
    onVeto: (tradeId: string) => void
    onWithdraw: (tradeId: string) => void
    onAnalyze: (trade: Trade) => void
    selected?: boolean
    brief?: boolean
    onOpen?: (trade: Trade) => void
}) {
    return <TradeCard trade={item.trade} myMemberId={myMemberId}
        tab={tab} tradeVetoMode={tradeVetoMode} isCommissioner={isCommissioner}
        acting={acting} selected={selected} brief={brief} onAccept={() => onAccept(item.trade)}
        onReject={() => onReject(item.trade.id)} onVeto={() => onVeto(item.trade.id)}
        onWithdraw={() => onWithdraw(item.trade.id)} onAnalyze={() => onAnalyze(item.trade)}
        onOpen={onOpen ? () => onOpen(item.trade) : undefined} />
})

const styles = StyleSheet.create({
    sectionRow: { paddingTop: spacing.xl, paddingBottom: spacing.sm },
    sectionText: { ...textStyles.sectionLabel },
    emptyRow: {
        minHeight: 56,
        justifyContent: 'center',
        paddingHorizontal: spacing.lg,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
    },
    emptyText: { ...textStyles.meta },
    blockRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingVertical: spacing.md },
    tile: {
        flex: 1,
        margin: spacing.xs,
        paddingHorizontal: spacing.lg,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous',
        backgroundColor: colors.bgCard,
    },
    pickBadge: {
        width: 36,
        height: 36,
        borderRadius: radii.full,
        backgroundColor: colors.bgMuted,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pickBadgeText: { fontSize: fontSize.xs, fontWeight: fontWeight.extrabold, color: colors.textSecondary },
    blockInfo: { flex: 1, minWidth: 0, gap: spacing.xxs },
    blockTitle: { ...textStyles.rowTitle },
    blockMetaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
    blockMeta: { ...textStyles.meta },
    blockContext: { fontSize: fontSize.xs, color: colors.primaryDark, fontWeight: fontWeight.semibold },
    blockNote: { ...textStyles.meta, fontStyle: 'italic', color: colors.textSecondary },
    blockAction: { minWidth: 72, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radii.md, borderCurve: 'continuous', borderWidth: 1, borderColor: colors.primaryBorder, paddingHorizontal: spacing.md },
    blockActionDisabled: { borderColor: colors.borderLight, backgroundColor: colors.bgMuted },
    blockActionText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
})
