import { View, Text, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { INJURY_COLORS, TRADE_STATUS_COLORS, colors, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
import { Trade, TradeItem, needsMemberAcceptance } from '@/lib/trades'
import { MotionPressable, MotionView } from '@/components/Motion'
import { Avatar } from '@/components/Avatar'
import { playerHeadshotUrl } from '@/lib/format'
import { playerEligiblePositions, playerSeasonContextText } from '@/lib/player-context'
import { PosTag } from '@/components/PosTag'
import { Badge } from '@/components/Badge'
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

const SHORT_DATE: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }

export type TradeCardActions = {
    acting: boolean
    onAccept: () => void
    onReject: () => void
    onVeto: () => void
    onWithdraw: () => void
}

export type TradeCardContext = {
    trade: Trade
    myMemberId: string
    tab: TradeTabKey
    tradeVetoMode?: TradeVetoMode
    isCommissioner?: boolean
}

/** Everything a card or detail view needs to describe a trade and its actions. */
export function tradeCardModel({ trade, myMemberId, tab, tradeVetoMode = 'member_vote', isCommissioner = false }: TradeCardContext) {
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
            ? `Veto window closes ${new Date(trade.vetoWindowExpiresAt).toLocaleString([], SHORT_DATE)}`
            : null,
        trade.status === 'pending' && trade.expiresAt
            ? `Expires ${new Date(trade.expiresAt).toLocaleString([], SHORT_DATE)}`
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

export type TradeCardModel = ReturnType<typeof tradeCardModel>

function tradeItemKey(item: TradeItem, index: number) {
    if (item.kind === 'player') return `player:${item.playerId}:${index}`
    if (item.kind === 'pick') return `pick:${item.pickId}:${index}`
    return `faab:${item.fromMemberId ?? 'from'}:${item.toMemberId ?? 'to'}:${item.amount}:${index}`
}

function TradeItemLine({ item, showContext = true }: { item: TradeItem; showContext?: boolean }) {
    if (item.kind === 'player') {
        const positions = playerEligiblePositions(item)
        return (
            <View style={styles.assetRow}>
                <Avatar
                    name={item.playerName}
                    uri={playerHeadshotUrl(item.nbaId) ?? undefined}
                    color={colors.bgMuted}
                    textColor={colors.textSecondary}
                    size={28}
                />
                <View style={styles.assetCopy}>
                    <Text style={styles.assetName} numberOfLines={1}>{item.playerName}</Text>
                    <View style={styles.assetMetaRow}>
                        {item.nbaTeam ? <Text style={styles.assetMeta}>{item.nbaTeam}</Text> : null}
                        {positions.map((pos) => <PosTag key={pos} position={pos} />)}
                        {item.injuryStatus ? (
                            <Badge
                                label={item.injuryStatus}
                                color={INJURY_COLORS[item.injuryStatus] ?? colors.textMuted}
                                variant="solid"
                            />
                        ) : null}
                    </View>
                    {showContext ? (
                        <Text style={styles.assetContext} numberOfLines={1}>{playerSeasonContextText(item)}</Text>
                    ) : null}
                </View>
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
                <Text style={styles.assetName}>{item.seasonYear} Round {item.round}</Text>
                <Text style={styles.assetMeta} numberOfLines={1}>via {item.originalTeamName}</Text>
            </View>
        </View>
    )
}

export function AssetList({ items, label, showContext = true }: { items: TradeItem[]; label: string; showContext?: boolean }) {
    return (
        <View style={styles.assetBlock}>
            <Text style={styles.assetLabel} numberOfLines={1}>{label}</Text>
            {items.length === 0 ? (
                <Text style={styles.assetEmpty}>Nothing</Text>
            ) : (
                items.map((item, index) => (
                    <TradeItemLine key={tradeItemKey(item, index)} item={item} showContext={showContext} />
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
            detail: [item.nbaTeam, ...playerEligiblePositions(item)].filter(Boolean).join(' · '),
        }
    }
    if (item.kind === 'pick') {
        return {
            key: tradeItemKey(item, index),
            fromMemberId: item.fromMemberId,
            toMemberId: item.toMemberId,
            label: `${item.seasonYear} Round ${item.round}`,
            detail: `${item.originalTeamName} pick`,
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
        <View style={[styles.statusChip, { backgroundColor: model.statusColors.bg }]}>
            <Text style={[styles.statusText, { color: model.statusColors.text }]}>{model.status}</Text>
        </View>
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
                    style={[styles.actionBtn, button.primary ? styles.actionBtnPrimary : styles.actionBtnSecondary]}
                    onPress={button.onPress}
                    disabled={actions.acting}
                    accessibilityRole="button"
                    accessibilityLabel={button.a11y}
                    accessibilityState={{ disabled: actions.acting }}
                    pressedScale={0.94}
                    {...ids(button.key)}
                >
                    <Text style={button.primary ? styles.actionTextPrimary : styles.actionTextSecondary}>{button.label}</Text>
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
    selected = false,
    brief = false,
    onAccept,
    onReject,
    onVeto,
    onWithdraw,
    onAnalyze,
    onOpen,
}: {
    trade: Trade
    myMemberId: string
    tab: TradeTabKey
    tradeVetoMode?: TradeVetoMode
    isCommissioner?: boolean
    acting: boolean
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
    const model = tradeCardModel({ trade, myMemberId, tab, tradeVetoMode, isCommissioner })

    // The summary is the press target, not the whole card, so the header and
    // action buttons never sit inside another button.
    const summary = (
        <>
            {model.meta.length > 0 ? <Text style={styles.meta} numberOfLines={2}>{model.meta.join(' · ')}</Text> : null}
            <View style={styles.sides}>
                <AssetList items={model.receives} label={model.receiveLabel} showContext={!brief && !trade.isMultiTeam} />
                <AssetList items={model.gives} label={model.giveLabel} showContext={!brief && !trade.isMultiTeam} />
            </View>
            {trade.notes && !brief ? <Text style={styles.notes} numberOfLines={2}>“{trade.notes}”</Text> : null}
        </>
    )

    return (
        <MotionView style={[styles.card, selected && styles.cardSelected]} preset="rise">
            <View style={styles.cardHeader}>
                <Text style={styles.cardOpponent} numberOfLines={2}>{model.opponentName}</Text>
                <View style={styles.cardHeaderControls}>
                    <MotionPressable
                        style={[styles.analyzeBtn, acting && styles.analyzeBtnDisabled]}
                        onPress={onAnalyze}
                        disabled={acting}
                        accessibilityRole="button"
                        accessibilityLabel={`Analyze trade from ${trade.proposerTeamName}`}
                        accessibilityState={{ disabled: acting }}
                        testID={`trade-analyze-${trade.id}`}
                        id={`trade-analyze-${trade.id}`}
                        pressedScale={0.94}
                    >
                        <Text style={styles.analyzeBtnText}>Analyze</Text>
                    </MotionPressable>
                    <StatusChip model={model} />
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
                    pressedScale={0.99}
                >
                    {summary}
                </MotionPressable>
            ) : <View style={styles.summary}>{summary}</View>}

            <TradeActionButtons
                trade={trade}
                model={model}
                actions={{ acting, onAccept, onReject, onVeto, onWithdraw }}
                withTestIds
            />
        </MotionView>
    )
}

const styles = StyleSheet.create({
    card: {
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        padding: spacing.lg,
        backgroundColor: colors.bgCard,
        gap: spacing.md,
    },
    cardSelected: { borderColor: colors.primary, borderWidth: 1.5 },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
    },
    cardOpponent: { ...textStyles.rowTitle, fontSize: fontSize.lg, lineHeight: 22, flex: 1, minWidth: 0 },
    cardHeaderControls: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 0 },
    analyzeBtn: {
        minHeight: 44,
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
        justifyContent: 'center',
    },
    analyzeBtnDisabled: { opacity: 0.5 },
    analyzeBtnText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
    statusChip: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xxs,
        borderRadius: radii.full,
        borderCurve: 'continuous' as const,
    },
    statusText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold },
    summary: { gap: spacing.md },
    meta: { ...textStyles.meta },
    sides: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
    assetBlock: { flexGrow: 1, flexBasis: 200, minWidth: 0, gap: spacing.xs },
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
        minHeight: 44,
        minWidth: 96,
        paddingHorizontal: spacing.xl,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionBtnPrimary: { backgroundColor: colors.primary },
    actionBtnSecondary: { backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
    actionTextPrimary: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },
    actionTextSecondary: { color: colors.textSecondary, fontWeight: fontWeight.semibold, fontSize: fontSize.md },
})
