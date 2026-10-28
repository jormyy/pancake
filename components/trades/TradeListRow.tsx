import { SectionBand } from '@/components/ui/SectionBand'
import { pickLabel } from '@/lib/picks'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { memo } from 'react'
import { useRouter } from 'expo-router'


import { TradeCard } from '@/components/trades/TradeCard'
import { TradeBlockNoteEditor } from '@/components/trades/TradeBlockNoteEditor'
import type { TradeTabKey } from '@/lib/trade-ui-model'
import { colors, componentTokens, controlSize, fontSize, table, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
import { playerEligiblePositions, playerSeasonContextText } from '@/lib/player-context'
import type { RosterPlayer } from '@/lib/roster'
import type { Trade, TradeBlockItem, TradePickItem } from '@/lib/trades'
import type { TradeListItem } from '@/lib/trades-screen-model'
import type { TradeVetoMode } from '@/lib/league'

type ItemOf<Type extends TradeListItem['_type']> = Extract<TradeListItem, { _type: Type }>

export const TradeSectionRow = memo(function TradeSectionRow({ item }: { item: ItemOf<'header'> }) {
    if (!item.label) return null
    return (
        <SectionBand variant="plain" label={item.label} style={styles.sectionRow} />
    )
})

export const TradeEmptyRow = memo(function TradeEmptyRow({ item }: { item: ItemOf<'empty'> }) {
    return <View style={styles.emptyRow}><Text style={styles.emptyText}>{item.message}</Text></View>
})

export const TradeBlockListingRow = memo(function TradeBlockListingRow({
    item,
    myMemberId,
    blockBusyId,
    disabled = false,
    tile = false,
    onRemove,
    onSaveNote,
}: {
    item: ItemOf<'blockItem'>
    myMemberId: string
    disabled?: boolean
    blockBusyId: string | null
    tile?: boolean
    onRemove: (item: TradeBlockItem) => void | Promise<void>
    onSaveNote: (item: TradeBlockItem, note: string) => Promise<boolean | undefined>
}) {
    const { push } = useRouter()
    const block = item.item
    const mine = block.memberId === myMemberId
    const label = block.asset.kind === 'player'
        ? block.asset.playerName
        : `${pickLabel(block.asset.seasonYear, block.asset.round)} pick`
    const positions = block.asset.kind === 'player' ? playerEligiblePositions(block.asset) : []
    return (
        <View style={[styles.blockRow, !tile && styles.compactBlockRow, tile && styles.tile]}>
            {block.asset.kind === 'player' ? <View style={styles.blockInfo}>
                <PlayerRowContent compact name={label} nbaId={block.asset.nbaId} team={block.asset.nbaTeam} positions={positions}
                    yearsExp={block.asset.yearsExp} careerGames={block.asset.careerGames} injuryStatus={block.asset.injuryStatus} onTaxi={block.rosterLocation === 'taxi'}
                    metadata={<Text style={styles.blockMeta}>{block.teamName}{block.rosterLocation ? ` · ${block.rosterLocation === 'active' ? 'Active' : block.rosterLocation.toUpperCase()}` : ''}</Text>} stats={playerSeasonContextText(block.asset)} />
                {mine ? <TradeBlockNoteEditor item={block} label={label}
                    disabled={disabled || blockBusyId === block.id} onSave={onSaveNote} />
                    : block.note ? <Text style={styles.blockNote} numberOfLines={2}>“{block.note}”</Text> : null}
            </View> : <>
                <View style={styles.pickBadge}><Text style={styles.pickBadgeText}>{`R${block.asset.round}`}</Text></View>
                <View style={styles.blockInfo}><Text style={styles.blockTitle}>{label}</Text><Text style={styles.blockMeta}>{block.teamName}</Text></View>
            </>}
            {mine ? (
                <Pressable style={styles.blockAction} onPress={() => onRemove(block)}
                    disabled={disabled || blockBusyId === block.id} accessibilityRole="button"
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
        <View style={[styles.blockRow, !tile && styles.compactBlockRow, tile && styles.tile]}>
            <PlayerRowContent compact name={player.display_name} nbaId={player.nba_id} team={player.nba_team} positions={positions}
                birthdate={player.birthdate} yearsExp={player.years_exp} careerGames={player.career_regular_season_games} injuryStatus={player.injury_status} onTaxi={item.player.is_on_taxi}
                metadata={<Text style={styles.blockMeta}>{item.player.is_on_ir ? 'IR' : item.player.is_on_taxi ? 'TAXI' : 'Active'}</Text>} stats={context} />
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
        <View style={[styles.blockRow, !tile && styles.compactBlockRow, tile && styles.tile]}>
            <View style={styles.pickBadge}><Text style={styles.pickBadgeText}>R{item.pick.round}</Text></View>
            <View style={styles.blockInfo}>
                <Text style={styles.blockTitle}>{pickLabel(item.pick.seasonYear, item.pick.round)}</Text>
                <Text style={styles.blockMeta}>
                    {item.pick.originalTeamName === myTeamName ? 'Own pick' : `via ${item.pick.originalTeamName}`}
                </Text>
            </View>
            <Pressable style={[styles.blockAction, listed && styles.blockActionDisabled]}
                onPress={() => onList(item.pick)} disabled={listed || busy}
                accessibilityRole="button" accessibilityLabel={`${listed ? 'Listed' : 'List'} ${pickLabel(item.pick.seasonYear, item.pick.round)} pick on trade block`}
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
    decisionsDisabled,
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
    decisionsDisabled?: boolean
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
        acting={acting} decisionsDisabled={decisionsDisabled} selected={selected} brief={brief} onAccept={() => onAccept(item.trade)}
        onReject={() => onReject(item.trade.id)} onVeto={() => onVeto(item.trade.id)}
        onWithdraw={() => onWithdraw(item.trade.id)} onAnalyze={() => onAnalyze(item.trade)}
        onOpen={onOpen ? () => onOpen(item.trade) : undefined} />
})

const styles = StyleSheet.create({
    sectionRow: { paddingTop: spacing.lg, paddingBottom: spacing.sm },
    emptyRow: { paddingVertical: spacing.sm },
    emptyText: { ...textStyles.meta },
    blockRow: { minHeight: table.rowHeight, flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingVertical: componentTokens.playerRow.standard.paddingVertical },
    compactBlockRow: { borderBottomWidth: 1, borderBottomColor: colors.borderLight, marginBottom: spacing.sm, paddingHorizontal: spacing.sm, paddingVertical: componentTokens.playerRow.compact.paddingVertical, gap: componentTokens.playerRow.compact.gap },
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
    blockAction: { minWidth: controlSize.minTouch, minHeight: controlSize.minTouch, alignItems: 'center', justifyContent: 'center', borderRadius: radii.md, borderCurve: 'continuous', borderWidth: 1, borderColor: colors.primaryBorder, paddingHorizontal: spacing.md },
    blockActionDisabled: { borderColor: colors.borderLight, backgroundColor: colors.bgMuted },
    blockActionText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
})
