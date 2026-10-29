import { useLeagueTimezone } from '@/hooks/use-league-timezone'
import { formatLeagueDateTime } from '@/lib/timezone'
import { PendingMutationBadge } from '@/components/PendingMutationBadge'
import { Badge } from '@/components/ui/Badge'
import { TradePickLabel } from '@/components/trades/TradePickLabel'
import { tradePickContext, type TradePickContext } from '@/lib/trade-pick-label'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { View, Text, StyleSheet } from 'react-native'
import { SavedTradeEstimate } from '@/components/trades/SavedTradeEstimate'
import { useRouter } from 'expo-router'
import { TRADE_STATUS_COLORS, colors, controlSize, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
import { Trade, TradeItem, type TradeRosterPlan, needsMemberAcceptance } from '@/lib/trades'
import { MotionPressable } from '@/components/Motion'

import { playerEligiblePositions, playerSeasonContextText } from '@/lib/player-context'

import { type TradeFlowItem } from '@/components/trades/MultiTeamTradeOverview'
import { tradeDisplayPerspective } from '@/lib/trade-perspective'
import type { TradeVetoMode } from '@/types/app'
import type { TradeTabKey } from '@/lib/trade-ui-model'

const STATUS_LABELS: Record<string, string> = {
    pending: 'Pending',
    accepted: 'Accepted',
    rejected: 'Rejected',
    withdrawn: 'Withdrawn',
    completed: 'Completed',
    expired: 'Expired',
    vetoed: 'Vetoed',
    countered: 'Countered',
    edited: 'Edited',
}

export type TradeCardActions = {
    acting: boolean
    acceptDisabled?: boolean
    reviewBeforeAccept?: boolean
    onAccept: () => void
    onRosterPlan?: (plan: TradeRosterPlan) => void
    onTaxiDestination?: (playerId: string, value: boolean) => void
    onReject: () => void
    onVeto: () => void
    onWithdraw: () => void
}

export type TradeCardContext = {
    timezone?: string
    trade: Trade
    myMemberId: string
    tab: TradeTabKey
    reviewMode?: 'propose' | 'accept'
    tradeVetoMode?: TradeVetoMode
    isCommissioner?: boolean
}

/** Everything a card or detail view needs to describe a trade and its actions. */
export function tradeCardModel({ trade, myMemberId, tab, tradeVetoMode = 'member_vote', isCommissioner = false, timezone }: TradeCardContext) {
    const isProposer = trade.proposerMemberId === myMemberId
    const isRecipient = trade.recipientMemberId === myMemberId
    const participants = trade.participants
    const isMultiParticipant = participants.some((participant) => participant.memberId === myMemberId)
    const isTradeParty = isProposer || isRecipient || isMultiParticipant
    const opponentName = trade.isMultiTeam && participants.length > 0
        ? `${participants.length}-team trade`
        : isProposer
            ? trade.recipientTeamName
            : isRecipient
                ? trade.proposerTeamName
                : `${trade.proposerTeamName} vs ${trade.recipientTeamName}`
    const perspective = tradeDisplayPerspective(trade, myMemberId)
    const canVetoBySettings = tradeVetoMode === 'member_vote' || (tradeVetoMode === 'commissioner' && isCommissioner)
    const canVeto = tab === 'offers' && !isTradeParty && trade.status === 'accepted' && !trade.myVetoed && canVetoBySettings
    const alreadyVetoed = tab === 'offers' && !isTradeParty && trade.status === 'accepted' && trade.myVetoed && canVetoBySettings
    const canRespond = tab === 'offers' && needsMemberAcceptance(trade, myMemberId)
    const canReject = canRespond && (!trade.isMultiTeam || !isProposer)
    const canEdit = tab === 'offers' && isProposer && trade.status === 'pending'
    const meta = [
        trade.status === 'accepted' && trade.vetoWindowExpiresAt
            ? `Veto window closes ${formatLeagueDateTime(trade.vetoWindowExpiresAt, timezone)}`
            : null,
        trade.status === 'pending' && trade.expiresAt
            ? `Expires ${formatLeagueDateTime(trade.expiresAt, timezone)}`
            : null,
        trade.isMultiTeam
            ? `${participants.filter((participant) => participant.acceptedAt != null).length}/${participants.length} teams accepted`
            : null,
        trade.version > 1 ? `Version ${trade.version}` : null,
        alreadyVetoed ? 'Your veto is recorded' : null,
    ].filter((part): part is string => part != null)
    return {
        opponentName,
        receives: perspective.receives,
        gives: perspective.gives,
        receiveLabel: perspective.receiveLabel.replace(/:\s*$/, ''),
        giveLabel: perspective.giveLabel.replace(/:\s*$/, ''),
        status: STATUS_LABELS[trade.status] ?? trade.status,
        statusColors: TRADE_STATUS_COLORS[trade.status] ?? TRADE_STATUS_COLORS.pending,
        meta,
        canRespond,
        canReject,
        canEdit,
        canVeto,
        isProposer,
    }
}

type TradeCardModel = ReturnType<typeof tradeCardModel>

function tradeItemKey(item: TradeItem, index: number) {
    if (item.kind === 'player') return `player:${item.playerId}:${index}`
    if (item.kind === 'pick') return `pick:${item.pickId}:${index}`
    return `faab:${item.fromMemberId ?? 'from'}:${item.toMemberId ?? 'to'}:${item.amount}:${index}`
}

function TradeItemLine({ item, showContext = true, pickContext }: { item: TradeItem; showContext?: boolean; pickContext?: TradePickContext }) {
    if (item.kind === 'player') {
        const positions = playerEligiblePositions(item)
        return (
            <View style={styles.assetRow}>
                <PlayerRowContent compact name={item.playerName} nbaId={item.nbaId} team={item.nbaTeam} positions={positions}
                    playerId={item.playerId} yearsExp={item.yearsExp} careerGames={item.careerGames} injuryStatus={item.injuryStatus}
                    metadata={item.toTaxi ? <Text style={styles.assetMeta}>To taxi</Text> : null}
                    stats={showContext ? playerSeasonContextText(item) : undefined} />
            </View>
        )
    }
    if (item.kind === 'faab') {
        return (
            <View style={styles.assetRow}>
                <View style={styles.assetIcon}><Text style={styles.assetIconText}>$</Text></View>
                <Text style={styles.assetName}>${item.amount} FAAB</Text>
            </View>
        )
    }
    return (
        <View style={styles.assetRow}>
            <View style={styles.assetIcon}><Text style={styles.assetIconText}>R{item.round}</Text></View>
            <View style={styles.assetCopy}>
                <TradePickLabel pick={item} context={pickContext} showDirection={false} />
            </View>
        </View>
    )
}

export function AssetList({ items, label, showContext = true, stacked = false, pickContext }: { items: TradeItem[]; label: string; showContext?: boolean; stacked?: boolean; pickContext?: TradePickContext }) {
    return (
        <View style={[styles.assetBlock, stacked && styles.stackedAssetBlock]}>
            <Text style={styles.assetLabel} numberOfLines={1}>{label}</Text>
            {items.length === 0 ? (
                <Text style={styles.assetEmpty}>Nothing</Text>
            ) : (
                items.map((item, index) => (
                    <TradeItemLine key={tradeItemKey(item, index)} item={item} showContext={showContext} pickContext={pickContext} />
                ))
            )}
        </View>
    )
}

export function tradeFlowItem(item: TradeItem, index: number): TradeFlowItem | null {
    if (!item.fromMemberId || !item.toMemberId) return null
    if (item.kind === 'player') {
        return {
            key: tradeItemKey(item, index),
            fromMemberId: item.fromMemberId,
            toMemberId: item.toMemberId,
            label: item.playerName,
            player: { name: item.playerName, nbaId: item.nbaId, team: item.nbaTeam, positions: playerEligiblePositions(item),
                playerId: item.playerId, yearsExp: item.yearsExp, careerGames: item.careerGames, injuryStatus: item.injuryStatus, stats: playerSeasonContextText(item) },
            detail: [item.nbaTeam, ...playerEligiblePositions(item), item.toTaxi ? 'To taxi' : null].filter(Boolean).join(' · '),
        }
    }
    if (item.kind === 'pick') {
        return {
            key: tradeItemKey(item, index),
            fromMemberId: item.fromMemberId,
            toMemberId: item.toMemberId,
            label: '',
            pick: item,
        }
    }
    return {
        key: tradeItemKey(item, index),
        fromMemberId: item.fromMemberId,
        toMemberId: item.toMemberId,
        label: `$${item.amount} FAAB`,
    }
}

export function StatusChip({ model }: { model: Pick<TradeCardModel, 'status' | 'statusColors'> }) {
    return (
        <Badge size="status" variant="solid" label={model.status} color={model.statusColors.bg} textColor={model.statusColors.text} />
    )
}

/**
 * The trade's response buttons. List cards pass `withTestIds` so browser tests
 * find exactly one control per trade; the detail view repeats them without ids.
 */
export function TradeActionButtons({
    trade,
    model,
    actions,
    withTestIds = false,
}: {
    trade: Trade
    model: TradeCardModel
    actions: TradeCardActions
    withTestIds?: boolean
}) {
    const { push } = useRouter()
    const ids = (name: string) => (withTestIds ? { testID: `trade-${name}-${trade.id}`, id: `trade-${name}-${trade.id}` } : {})
    const opponent = model.opponentName
    const buttons: { key: string; label: string; primary?: boolean; a11y: string; onPress: () => void }[] = []
    if (model.canRespond) {
        buttons.push({ key: 'accept', label: 'Accept', primary: true, a11y: `Accept trade with ${opponent}`, onPress: actions.onAccept })
        if (model.canReject) buttons.push({ key: 'reject', label: 'Reject', a11y: `Reject trade with ${opponent}`, onPress: actions.onReject })
        buttons.push({
            key: 'counter',
            label: 'Counter',
            a11y: `Counter trade with ${opponent}`,
            onPress: () => push({ pathname: '/(modals)/propose-trade', params: { counterTradeId: trade.id } }),
        })
    }
    if (model.canEdit) {
        buttons.push({
            key: 'edit',
            label: 'Edit',
            primary: true,
            a11y: `Edit trade with ${opponent}`,
            onPress: () => push({ pathname: '/(modals)/propose-trade', params: { editTradeId: trade.id } }),
        })
        buttons.push({ key: 'withdraw', label: 'Withdraw', a11y: `Withdraw trade with ${opponent}`, onPress: actions.onWithdraw })
    }
    if (model.canVeto) {
        buttons.push({
            key: 'veto',
            label: 'Veto',
            a11y: `Veto trade between ${trade.proposerTeamName} and ${trade.recipientTeamName}`,
            onPress: actions.onVeto,
        })
    }
    if (buttons.length === 0) return null
    return (
        <View style={styles.actions}>
            {buttons.map((button) => (
                <MotionPressable
                    key={button.key}
                    style={[styles.actionBtn, button.primary ? styles.actionBtnPrimary : styles.actionBtnSecondary, button.key === 'accept' && actions.acceptDisabled && styles.actionBtnDisabled]}
                    onPress={button.onPress}
                    disabled={actions.acting || button.key === 'accept' && actions.acceptDisabled}
                    accessibilityRole="button"
                    accessibilityLabel={button.a11y}
                    accessibilityState={{ disabled: actions.acting || button.key === 'accept' && actions.acceptDisabled }}
                    {...ids(button.key)}
                >
                    <Text style={[button.primary ? styles.actionTextPrimary : styles.actionTextSecondary, button.key === 'accept' && actions.acceptDisabled && styles.actionTextDisabled]}>{button.label}</Text>
                </MotionPressable>
            ))}
        </View>
    )
}

/**
 * One trade in a list: who it is with, its status, what each side gets, and
 * the response that matters now. Pressing the card opens its full details.
 */
export function TradeCard({
    trade,
    myMemberId,
    tab,
    tradeVetoMode = 'member_vote',
    isCommissioner = false,
    acting,
    decisionsDisabled = false,
    selected = false,
    brief = false,
    onAccept,
    onReject,
    onVeto,
    onWithdraw,
    onAnalyze,
    onOpen,
    reviewMode,
}: {
    trade: Trade
    myMemberId: string
    tab: TradeTabKey
    reviewMode?: 'propose' | 'accept'
    tradeVetoMode?: TradeVetoMode
    isCommissioner?: boolean
    acting: boolean
    decisionsDisabled?: boolean
    selected?: boolean
    /** Beside an open detail pane: names only, the pane shows season context and notes. */
    brief?: boolean
    onAccept: () => void
    onReject: () => void
    onVeto: () => void
    onWithdraw: () => void
    /** Opens the Trade Analyzer prefilled with this trade; rendered in the card header. */
    onAnalyze: () => void
    /** Shows the full trade: a side pane on wide screens, a sheet on phones. */
    onOpen?: () => void
}) {
    const timezone = useLeagueTimezone()
    const model = tradeCardModel({ trade, myMemberId, tab, tradeVetoMode, isCommissioner, timezone })
    const pickContext = tradePickContext(trade, myMemberId)
    if (reviewMode === 'propose') model.status = 'Draft'

    // The summary is the press target, not the whole card, so the header and
    // action buttons never sit inside another button.
    const summary = (
        <>
            {model.meta.length > 0 ? <Text style={styles.meta} numberOfLines={2}>{model.meta.join(' · ')}</Text> : null}
            <View style={[styles.sides, tab === 'history' && { flexDirection: 'column' }]}>
                <AssetList items={model.receives} label={model.receiveLabel} pickContext={pickContext} stacked={tab === 'history'} showContext={tab !== 'history' && !brief && !trade.isMultiTeam} />
                <AssetList items={model.gives} label={model.giveLabel} pickContext={pickContext} stacked={tab === 'history'} showContext={tab !== 'history' && !brief && !trade.isMultiTeam} />
            </View>
            {trade.notes && !brief ? <Text style={styles.notes} numberOfLines={2}>“{trade.notes}”</Text> : null}
        </>
    )

    return (
        <View style={[styles.card, selected && styles.cardSelected]} testID={reviewMode ? 'trade-review-card' : undefined}>
            <PendingMutationBadge rowId={trade.id} />
            <View style={styles.cardHeader}>
                <Text style={styles.cardOpponent} numberOfLines={2}>{model.opponentName}</Text>
                <View style={styles.cardHeaderControls}>
                    {!reviewMode ? <MotionPressable
                        style={[styles.analyzeBtn, acting && styles.analyzeBtnDisabled]}
                        onPress={onAnalyze}
                        disabled={acting}
                        accessibilityRole="button"
                        accessibilityLabel={`Revalue trade from ${trade.proposerTeamName} with current inputs`}
                        accessibilityState={{ disabled: acting }}
                        testID={`trade-analyze-${trade.id}`}
                        id={`trade-analyze-${trade.id}`}
                    >
                        <Text style={styles.analyzeBtnText}>Revalue</Text>
                    </MotionPressable> : null}
                    {reviewMode === 'propose' || trade.status !== 'pending' || model.isProposer || tab !== 'offers' ? <StatusChip model={model} /> : null}
                </View>
            </View>

            {onOpen ? (
                <MotionPressable
                    style={styles.summary}
                    onPress={onOpen}
                    accessibilityRole="button"
                    accessibilityLabel={`Show details of trade with ${model.opponentName}`}
                    accessibilityState={{ selected }}
                    testID={`trade-details-${trade.id}`}
                    id={`trade-details-${trade.id}`}
                >
                    {summary}
                </MotionPressable>
            ) : <View style={styles.summary}>{summary}</View>}

            {!reviewMode ? <SavedTradeEstimate trade={trade} myMemberId={myMemberId} /> : null}

            {!reviewMode ? <TradeActionButtons
                trade={trade}
                model={model}
                actions={{ acting: acting || decisionsDisabled, reviewBeforeAccept: Boolean(onOpen), onAccept, onReject, onVeto, onWithdraw }}
                withTestIds
            /> : null}
        </View>
    )
}

const styles = StyleSheet.create({
    card: {
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        padding: spacing.sm,
        backgroundColor: colors.bgCard,
        gap: spacing.xs,
    },
    cardSelected: { borderColor: colors.primary, borderWidth: 1.5 },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
    },
    cardOpponent: { ...textStyles.rowTitle, fontSize: fontSize.lg, flex: 1, minWidth: 0 },
    cardHeaderControls: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 0 },
    analyzeBtn: {
        minHeight: controlSize.minTouch,
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
        justifyContent: 'center',
    },
    analyzeBtnDisabled: { opacity: 0.5 },
    analyzeBtnText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
    summary: { gap: spacing.md },
    meta: { ...textStyles.meta },
    sides: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
    assetBlock: { flexGrow: 1, flexBasis: 200, minWidth: 0, gap: spacing.xs },
    stackedAssetBlock: { flexGrow: 0, flexBasis: 'auto' },
    assetLabel: { ...textStyles.sectionLabel },
    assetEmpty: { ...textStyles.meta, color: colors.textPlaceholder },
    assetRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 32 },
    assetCopy: { flex: 1, minWidth: 0, gap: spacing.xxs },
    assetName: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    assetMetaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
    assetMeta: { fontSize: fontSize.xs, color: colors.textMuted },
    assetContext: { fontSize: fontSize.xs, color: colors.primaryDark, fontWeight: fontWeight.semibold },
    assetIcon: {
        width: 28,
        height: 28,
        borderRadius: radii.full,
        backgroundColor: colors.bgMuted,
        alignItems: 'center',
        justifyContent: 'center',
    },
    assetIconText: { fontSize: fontSize['2xs'], fontWeight: fontWeight.extrabold, color: colors.textSecondary },
    notes: { ...textStyles.meta, fontStyle: 'italic', color: colors.textSecondary },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
    actionBtn: {
        minHeight: controlSize.minTouch,
        minWidth: 96,
        paddingHorizontal: spacing.xl,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionBtnDisabled: { backgroundColor: colors.bgMuted },
    actionTextDisabled: { color: colors.textDisabled },
    actionBtnPrimary: { backgroundColor: colors.primary },
    actionBtnSecondary: { backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
    actionTextPrimary: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },
    actionTextSecondary: { color: colors.textSecondary, fontWeight: fontWeight.semibold, fontSize: fontSize.md },
})
