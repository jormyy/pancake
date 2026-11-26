import { SectionBand } from '@/components/ui/SectionBand'
import { pickLabel } from '@/lib/picks'
import { TradePlayerLink } from '@/components/trades/TradePlayerLink'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { memo, useState, type ReactNode } from 'react'
import { PendingTradeRosterPlan } from './PendingTradeRosterPlan'
import { useRouter } from 'expo-router'


import { TradeCard } from '@/components/trades/TradeCard'
import { TradeBlockNoteButton, TradeBlockNoteEditor } from '@/components/trades/TradeBlockNoteEditor'
import type { TradeTabKey } from '@/lib/trade-ui-model'
import { borderWidth, colors, componentTokens, controlSize, table, fontWeight, radii, spacing, textStyles, typeScale } from '@/constants/tokens'
import { playerEligiblePositions, playerSeasonContextText } from '@/lib/player-context'
import type { RosterPlayer } from '@/lib/roster'
import type { Trade, TradeBlockItem, TradePickItem } from '@/lib/trades'
import type { TradeListItem } from '@/lib/trades-screen-model'
import type { TradeVetoMode } from '@/lib/league'
import { rosterLocation } from '@/lib/roster-capacity'

type ItemOf<Type extends TradeListItem['_type']> = Extract<TradeListItem, { _type: Type }>

export const TradeSectionRow = memo(function TradeSectionRow({ item, standalone = false }: { item: ItemOf<'header'>; standalone?: boolean }) {
    if (!item.label) return null
    if (!standalone) return <SectionBand label={item.label} />
    return <View style={styles.bandCard}><SectionBand label={item.label} style={styles.bandBottomless} /></View>
})

export const TradeEmptyRow = memo(function TradeEmptyRow({ item }: { item: ItemOf<'empty'> }) {
    return <View style={styles.emptyRow}><Text style={styles.emptyText}>{item.message}</Text></View>
})

export function TradeCardFrame({ first, last, children }: { first: boolean; last: boolean; children: ReactNode }) {
    return (
        <View style={last && styles.cardSpacer}>
            <View style={[styles.cardFrame, first && styles.cardFirst, last && styles.cardLast, !first && !last && styles.rowDivider]}>
                {children}
            </View>
        </View>
    )
}

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
    const note = block.note?.trim() ?? ''
    const busy = disabled || blockBusyId === block.id
    const [editingNote, setEditingNote] = useState(false)
    return <>
        <View style={[styles.blockRow, !tile && styles.compactBlockRow, tile && styles.tile]}>
            {block.asset.kind === 'player' ? (
                <TradePlayerLink compact name={label} nbaId={block.asset.nbaId} team={block.asset.nbaTeam} positions={positions}
                    playerId={block.asset.playerId} yearsExp={block.asset.yearsExp} careerGames={block.asset.careerGames} injuryStatus={block.asset.injuryStatus} onTaxi={block.rosterLocation === 'taxi'}
                    metadata={<Text style={styles.blockMeta} numberOfLines={1}>{blockListingMeta(block, note)}</Text>}
                    stats={playerSeasonContextText(block.asset)} />
            ) : <>
                <View style={styles.pickBadge}><Text style={styles.pickBadgeText}>{`R${block.asset.round}`}</Text></View>
                <View style={styles.blockInfo}>
                    <Text style={styles.blockTitle} numberOfLines={1}>{label}</Text>
                    <Text style={styles.blockMeta} numberOfLines={1}>{blockListingMeta(block, note)}</Text>
                </View>
            </>}
            <View style={styles.blockActions}>
                {mine ? <>
                    <TradeBlockNoteButton label={label} disabled={busy} onPress={() => setEditingNote(true)} />
                    <Pressable style={styles.blockAction} onPress={() => onRemove(block)}
                        disabled={busy} accessibilityRole="button"
                        accessibilityLabel={`Remove ${label} from trade block`}>
                        <Text style={styles.blockActionText} numberOfLines={1}>Remove</Text>
                    </Pressable>
                </> : (
                    <Pressable style={styles.blockAction} onPress={() => push({
                        pathname: '/(modals)/propose-trade',
                        params: {
                            recipientMemberId: block.memberId,
                            requestPlayerId: block.asset.kind === 'player' ? block.asset.playerId : undefined,
                            requestPickId: block.asset.kind === 'pick' ? block.asset.pickId : undefined,
                        },
                    })} accessibilityRole="button" accessibilityLabel={`Offer for ${label}`}>
                        <Text style={styles.blockActionText} numberOfLines={1}>Offer</Text>
                    </Pressable>
                )}
            </View>
        </View>
        {mine && editingNote ? (
            <View style={styles.blockEditorRow}>
                <TradeBlockNoteEditor item={block} label={label} disabled={busy} onSave={onSaveNote}
                    onClose={() => setEditingNote(false)} />
            </View>
        ) : null}
    </>
})

function blockListingMeta(block: TradeBlockItem, note: string) {
    const location = block.asset.kind === 'player' && block.rosterLocation
        ? block.rosterLocation === 'active' ? 'Active' : block.rosterLocation.toUpperCase()
        : null
    return [block.teamName, location, note ? `\u201c${note}\u201d` : null].filter(Boolean).join(' \u00b7 ')
}

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
    const location = rosterLocation(item.player)
    const positions = playerEligiblePositions({ position: player.position, eligiblePositions: player.eligible_positions })
    const context = playerSeasonContextText({
        yearsExp: player.years_exp,
        avgFantasyPoints: blockAvgMap.get(player.id) ?? null,
        avgMinutesPlayed: blockAvgStatsMap.get(player.id)?.avg_minutes_played ?? null,
    })
    return (
        <View style={[styles.blockRow, !tile && styles.compactBlockRow, tile && styles.tile]}>
            <TradePlayerLink compact playerId={player.id} name={player.display_name} nbaId={player.nba_id} team={player.nba_team} positions={positions}
                birthdate={player.birthdate} yearsExp={player.years_exp} careerGames={player.career_regular_season_games} injuryStatus={player.injury_status} onTaxi={location === 'taxi'}
                metadata={<Text style={styles.blockMeta} numberOfLines={1}>{location === 'ir' ? 'IR' : location === 'taxi' ? 'TAXI' : 'Active'}</Text>} stats={context} />
            <Pressable style={[styles.blockAction, styles.listAction, listed && styles.blockActionDisabled]}
                onPress={() => onList(item.player)} disabled={listed || busy}
                accessibilityRole="button" accessibilityLabel={`${listed ? 'Listed' : 'List'} ${player.display_name} on trade block`}
                accessibilityState={{ disabled: listed || busy }}>
                <Text style={styles.blockActionText} numberOfLines={1}>{listed ? 'Listed' : 'List'}</Text>
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
                <Text style={styles.blockTitle} numberOfLines={1}>{pickLabel(item.pick.seasonYear, item.pick.round)}</Text>
                <Text style={styles.blockMeta} numberOfLines={1}>
                    {item.pick.originalTeamName === myTeamName ? 'Own pick' : `via ${item.pick.originalTeamName}`}
                </Text>
            </View>
            <Pressable style={[styles.blockAction, styles.listAction, listed && styles.blockActionDisabled]}
                onPress={() => onList(item.pick)} disabled={listed || busy}
                accessibilityRole="button" accessibilityLabel={`${listed ? 'Listed' : 'List'} ${pickLabel(item.pick.seasonYear, item.pick.round)} pick on trade block`}
                accessibilityState={{ disabled: listed || busy }}>
                <Text style={styles.blockActionText} numberOfLines={1}>{listed ? 'Listed' : 'List'}</Text>
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
    onWithdrawAcceptance,
    holdReady = false,
    onAnalyze,
    selected = false,
    brief = false,
    embedded = false,
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
    onWithdrawAcceptance?: (tradeId: string) => void
    holdReady?: boolean
    onAnalyze: (trade: Trade) => void
    selected?: boolean
    brief?: boolean
    embedded?: boolean
    onOpen?: (trade: Trade) => void
}) {
    const [accepting, setAccepting] = useState(false)
    return <><TradeCard trade={item.trade} myMemberId={myMemberId}
        tab={tab} tradeVetoMode={tradeVetoMode} isCommissioner={isCommissioner} holdReady={holdReady}
        acting={acting} decisionsDisabled={decisionsDisabled} selected={selected} brief={brief} onAccept={() => setAccepting(true)}
        embedded={embedded}
        onReject={() => onReject(item.trade.id)} onVeto={() => onVeto(item.trade.id)}
        onWithdraw={() => onWithdraw(item.trade.id)} onWithdrawAcceptance={onWithdrawAcceptance ? () => onWithdrawAcceptance(item.trade.id) : undefined}
        onAnalyze={() => onAnalyze(item.trade)}
        onOpen={onOpen ? () => onOpen(item.trade) : undefined} />
        {accepting ? <PendingTradeRosterPlan trade={item.trade} memberId={myMemberId} onCancel={() => setAccepting(false)}
            onConfirmed={() => { setAccepting(false); onAccept(item.trade) }} /> : null}</>
})

const styles = StyleSheet.create({
    cardFrame: {
        backgroundColor: colors.bgCard,
        borderLeftWidth: borderWidth.thin,
        borderRightWidth: borderWidth.thin,
        borderColor: colors.borderLight,
    },
    cardFirst: {
        borderTopWidth: borderWidth.thin,
        borderTopLeftRadius: radii.xl,
        borderTopRightRadius: radii.xl,
        borderCurve: 'continuous',
        overflow: 'hidden',
    },
    cardLast: {
        borderBottomWidth: borderWidth.thin,
        borderBottomLeftRadius: radii.xl,
        borderBottomRightRadius: radii.xl,
        borderCurve: 'continuous',
        overflow: 'hidden',
    },
    cardSpacer: { paddingBottom: spacing.md },
    rowDivider: { borderBottomWidth: borderWidth.thin, borderBottomColor: colors.separator },
    bandCard: {
        marginTop: spacing.md,
        borderWidth: borderWidth.thin,
        borderColor: colors.borderLight,
        borderRadius: radii.xl,
        borderCurve: 'continuous',
        overflow: 'hidden',
    },
    bandBottomless: { borderBottomWidth: 0 },
    emptyRow: {
        minHeight: controlSize.minTouch,
        justifyContent: 'center',
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
    },
    emptyText: { ...textStyles.meta, color: colors.textSecondary },
    blockRow: { minHeight: table.rowHeight, flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingVertical: componentTokens.playerRow.standard.paddingVertical },
    compactBlockRow: {
        paddingHorizontal: spacing.lg,
        paddingVertical: componentTokens.playerRow.compact.paddingVertical,
        gap: componentTokens.playerRow.compact.gap,
    },
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
        flexShrink: 0,
        width: 36,
        height: 36,
        borderRadius: radii.full,
        backgroundColor: colors.bgMuted,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pickBadgeText: { ...typeScale.caption, fontWeight: fontWeight.extrabold, color: colors.textSecondary },
    blockInfo: { flex: 1, minWidth: 0, gap: spacing.xxs },
    blockTitle: { ...textStyles.rowTitle, flexShrink: 1, minWidth: 0 },
    blockMetaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
    blockMeta: { ...textStyles.meta, flexShrink: 1 },
    blockContext: { ...typeScale.caption, color: colors.primaryDark, fontWeight: fontWeight.semibold },
    blockActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 0 },
    blockEditorRow: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    blockAction: { flexShrink: 0, minWidth: controlSize.minTouch, minHeight: controlSize.minTouch, alignItems: 'center', justifyContent: 'center', borderRadius: radii.md, borderCurve: 'continuous', borderWidth: 1, borderColor: colors.primaryBorder, paddingHorizontal: spacing.md },
    listAction: { minWidth: controlSize.minTouch + spacing.lg },
    blockActionDisabled: { borderColor: colors.borderLight, backgroundColor: colors.bgMuted },
    blockActionText: { ...typeScale.small, fontWeight: fontWeight.bold, color: colors.primaryDark },
})
