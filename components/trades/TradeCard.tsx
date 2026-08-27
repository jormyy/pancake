import { View, Text, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { INJURY_COLORS, TRADE_STATUS_COLORS, colors, fontSize, fontWeight, radii, spacing, uiColors } from '@/constants/tokens'
import { Trade, TradeItem, needsMemberAcceptance } from '@/lib/trades'
import { MotionPressable, MotionView } from '@/components/Motion'
import { Avatar } from '@/components/Avatar'
import { playerHeadshotUrl } from '@/lib/format'
import { playerEligiblePositions, playerSeasonContextText } from '@/lib/player-context'
import { PosTag } from '@/components/PosTag'
import { Badge } from '@/components/Badge'
import { MultiTeamTradeOverview, type TradeFlowItem } from '@/components/trades/MultiTeamTradeOverview'
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

const STATUS_COLORS = TRADE_STATUS_COLORS

function tradeItemKey(item: TradeItem, index: number) {
    if (item.kind === 'player') return `player:${item.playerId}:${index}`
    if (item.kind === 'pick') return `pick:${item.pickId}:${index}`
    return `faab:${item.fromMemberId ?? 'from'}:${item.toMemberId ?? 'to'}:${item.amount}:${index}`
}

function TradeItemLine({ item }: { item: TradeItem }) {
    if (item.kind === 'player') {
        const positions = playerEligiblePositions(item)
        return (
            <View style={styles.assetPlayerRow}>
                <Avatar
                    name={item.playerName}
                    uri={playerHeadshotUrl(item.nbaId) ?? undefined}
                    color={colors.bgMuted}
                    textColor={colors.textSecondary}
                    size={26}
                />
                <View style={styles.assetPlayerCopy}>
                    <Text style={styles.assetPlayer} numberOfLines={1}>{item.playerName}</Text>
                    <View style={styles.assetPlayerMetaRow}>
                        {item.nbaTeam ? <Text style={styles.assetPlayerMeta}>{item.nbaTeam}</Text> : null}
                        {positions.map((pos) => <PosTag key={pos} position={pos} />)}
                        {item.injuryStatus ? (
                            <Badge
                                label={item.injuryStatus}
                                color={INJURY_COLORS[item.injuryStatus] ?? colors.textMuted}
                                variant="solid"
                            />
                        ) : null}
                    </View>
                    <Text style={styles.assetPlayerContext} numberOfLines={1}>
                        {playerSeasonContextText(item)}
                    </Text>
                </View>
            </View>
        )
    }
    if (item.kind === 'faab') {
        return <Text style={styles.assetPlayer}>FAAB ${item.amount}</Text>
    }
    return (
        <Text style={styles.assetPick}>
            {item.seasonYear} Rd {item.round}{' '}
            <Text style={styles.assetPickVia}>(via {item.originalTeamName})</Text>
        </Text>
    )
}

function AssetList({ items, label }: { items: TradeItem[]; label: string }) {
    return (
        <View style={styles.assetBlock}>
            <Text style={styles.assetLabel}>{label}</Text>
            {items.length === 0 ? (
                <Text style={styles.assetEmpty}>Nothing</Text>
            ) : (
                items.map((item, index) => (
                    <TradeItemLine
                        key={tradeItemKey(item, index)}
                        item={item}
                    />
                ))
            )}
        </View>
    )
}

function tradeFlowItem(item: TradeItem, index: number): TradeFlowItem | null {
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

export function TradeCard({
    trade,
    myMemberId,
    tab,
    tradeVetoMode = 'member_vote',
    isCommissioner = false,
    acting,
    onAccept,
    onReject,
    onVeto,
    onWithdraw,
    onAnalyze,
}: {
    trade: Trade
    myMemberId: string
    tab: TradeTabKey
    tradeVetoMode?: TradeVetoMode
    isCommissioner?: boolean
    acting: boolean
    onAccept: () => void
    onReject: () => void
    onVeto: () => void
    onWithdraw: () => void
    /** Opens the Trade Analyzer prefilled with this trade; rendered in the card header when provided. */
    onAnalyze?: () => void
}) {
    const { push } = useRouter()
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
    const iReceive = perspective.receives
    const iGive = perspective.gives
    const receiveLabel = perspective.receiveLabel
    const giveLabel = perspective.giveLabel

    const statusStyle = STATUS_COLORS[trade.status] ?? STATUS_COLORS.pending
    const canVetoBySettings =
        tradeVetoMode === 'member_vote' ||
        (tradeVetoMode === 'commissioner' && isCommissioner)
    const canVeto = tab === 'offers' && !isTradeParty && trade.status === 'accepted' && !trade.myVetoed && canVetoBySettings
    const alreadyVetoed = tab === 'offers' && !isTradeParty && trade.status === 'accepted' && trade.myVetoed && canVetoBySettings
    const canRespond = tab === 'offers' && needsMemberAcceptance(trade, myMemberId)
    const canReject = canRespond && (!trade.isMultiTeam || !isProposer)
    const participantAcceptanceText = trade.isMultiTeam
        ? `${participants.filter((participant) => participant.acceptedAt != null).length}/${participants.length} teams accepted`
        : null
    const vetoWindowText = trade.status === 'accepted' && trade.vetoWindowExpiresAt
        ? `Veto window closes ${new Date(trade.vetoWindowExpiresAt).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        })}`
        : null
    const expiresText = trade.status === 'pending' && trade.expiresAt
        ? `Expires ${new Date(trade.expiresAt).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        })}`
        : null

    return (
        <MotionView style={styles.card} preset="rise">
            <View style={styles.cardHeader}>
                <Text style={styles.cardOpponent} numberOfLines={1}>{opponentName}</Text>
                <View style={styles.cardHeaderControls}>
                    {onAnalyze ? (
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
                    ) : null}
                    <View style={[styles.statusBadge, { backgroundColor: statusStyle.bg }]}>
                        <Text style={[styles.statusText, { color: statusStyle.text }]}>
                            {STATUS_LABELS[trade.status] ?? trade.status}
                        </Text>
                    </View>
                </View>
            </View>

            {vetoWindowText ? <Text style={styles.vetoWindowText}>{vetoWindowText}</Text> : null}
            {expiresText ? <Text style={styles.vetoWindowText}>{expiresText}</Text> : null}
            {trade.version > 1 ? <Text style={styles.vetoWindowText}>Version {trade.version}</Text> : null}
            {participantAcceptanceText ? <Text style={styles.vetoWindowText}>{participantAcceptanceText}</Text> : null}
            {alreadyVetoed ? <Text style={styles.vetoWindowText}>Your veto has been recorded.</Text> : null}

            {canRespond && (
                <View style={styles.cardActions}>
                    <MotionPressable
                        style={[styles.actionBtn, styles.actionBtnAccept]}
                        onPress={onAccept}
                        disabled={acting}
                        accessibilityRole="button"
                        accessibilityLabel={`Accept trade with ${opponentName}`}
                        testID={`trade-accept-${trade.id}`}
                        id={`trade-accept-${trade.id}`}
                        pressedScale={0.94}
                    >
                        <Text style={styles.actionBtnAcceptText}>Accept</Text>
                    </MotionPressable>
                    {canReject ? (
                        <MotionPressable
                            style={[styles.actionBtn, styles.actionBtnReject]}
                            onPress={onReject}
                            disabled={acting}
                            accessibilityRole="button"
                            accessibilityLabel={`Reject trade with ${opponentName}`}
                            testID={`trade-reject-${trade.id}`}
                            id={`trade-reject-${trade.id}`}
                            pressedScale={0.94}
                        >
                            <Text style={styles.actionBtnRejectText}>Reject</Text>
                        </MotionPressable>
                    ) : null}
                    <MotionPressable
                        style={[styles.actionBtn, styles.actionBtnReject]}
                        onPress={() => push({ pathname: '/(modals)/propose-trade', params: { counterTradeId: trade.id } })}
                        disabled={acting}
                        accessibilityRole="button"
                        accessibilityLabel={`Counter trade with ${opponentName}`}
                        testID={`trade-counter-${trade.id}`}
                        id={`trade-counter-${trade.id}`}
                        pressedScale={0.94}
                    >
                        <Text style={styles.actionBtnRejectText}>Counter</Text>
                    </MotionPressable>
                </View>
            )}
            {tab === 'offers' && isProposer && trade.status === 'pending' && (
                <View style={styles.cardActions}>
                    <MotionPressable
                        style={[styles.actionBtn, styles.actionBtnAccept]}
                        onPress={() => push({ pathname: '/(modals)/propose-trade', params: { editTradeId: trade.id } })}
                        disabled={acting}
                        accessibilityRole="button"
                        accessibilityLabel={`Edit trade with ${opponentName}`}
                        testID={`trade-edit-${trade.id}`}
                        id={`trade-edit-${trade.id}`}
                        pressedScale={0.94}
                    >
                        <Text style={styles.actionBtnAcceptText}>Edit</Text>
                    </MotionPressable>
                    <MotionPressable
                        style={[styles.actionBtn, styles.actionBtnReject]}
                        onPress={onWithdraw}
                        disabled={acting}
                        accessibilityRole="button"
                        accessibilityLabel={`Withdraw trade with ${opponentName}`}
                        testID={`trade-withdraw-${trade.id}`}
                        id={`trade-withdraw-${trade.id}`}
                        pressedScale={0.94}
                    >
                        <Text style={styles.actionBtnRejectText}>Withdraw</Text>
                    </MotionPressable>
                </View>
            )}
            {canVeto && (
                <View style={styles.cardActions}>
                    <MotionPressable
                        style={[styles.actionBtn, styles.actionBtnReject]}
                        onPress={onVeto}
                        disabled={acting}
                        accessibilityRole="button"
                        accessibilityLabel={`Veto trade between ${trade.proposerTeamName} and ${trade.recipientTeamName}`}
                        testID={`trade-veto-${trade.id}`}
                        id={`trade-veto-${trade.id}`}
                        pressedScale={0.94}
                    >
                        <Text style={styles.actionBtnRejectText}>Veto</Text>
                    </MotionPressable>
                </View>
            )}

            {trade.isMultiTeam ? (
                <MultiTeamTradeOverview
                    compact
                    participants={participants.map((participant) => ({
                        memberId: participant.memberId,
                        label: participant.memberId === myMemberId ? 'You' : participant.teamName,
                        statusLabel: participant.acceptedAt ? 'Accepted' : 'Waiting',
                        statusComplete: participant.acceptedAt != null,
                    }))}
                    items={trade.routedItems.flatMap((item, index) => tradeFlowItem(item, index) ?? [])}
                />
            ) : (
                <>
                    <AssetList items={iReceive} label={receiveLabel} />
                    <AssetList items={iGive} label={giveLabel} />
                </>
            )}

            {trade.notes ? <Text style={styles.cardNotes}>{trade.notes}</Text> : null}

        </MotionView>
    )
}

const styles = StyleSheet.create({
    card: {
        borderWidth: 1,
        borderColor: uiColors.borderNeutral,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        padding: 14,
        backgroundColor: uiColors.surfaceAlt,
        gap: spacing.xs,
        marginHorizontal: spacing.xl,
        marginTop: spacing.md,
        marginBottom: spacing.md,
    },
    cardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: spacing.sm,
    },
    cardOpponent: { fontSize: 15, fontWeight: fontWeight.bold, color: colors.textPrimary, flex: 1, minWidth: 0 },
    cardHeaderControls: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 0 },
    analyzeBtn: {
        minHeight: 44,
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    analyzeBtnDisabled: { opacity: 0.5 },
    analyzeBtnText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
    statusBadge: {
        paddingHorizontal: spacing.md,
        paddingVertical: 3,
        borderRadius: radii.sm,
        borderCurve: 'continuous' as const,
    },
    statusText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold },

    assetBlock: { marginBottom: spacing.xs },
    assetLabel: { fontSize: 12, fontWeight: fontWeight.semibold, color: colors.textPrimary, marginBottom: spacing.xxs },
    assetEmpty: { fontSize: fontSize.sm, color: colors.textPlaceholder },
    assetPlayerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs },
    assetPlayerCopy: { flex: 1, minWidth: 0 },
    assetPlayer: { fontSize: fontSize.sm, color: colors.textSecondary },
    assetPlayerMeta: { fontSize: fontSize.xs, color: colors.textMuted },
    assetPlayerMetaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 1 },
    assetPlayerContext: { fontSize: fontSize.xs, color: colors.primaryDark, fontWeight: fontWeight.bold, marginTop: 1 },
    assetPick: { fontSize: fontSize.sm, color: colors.textSecondary, fontStyle: 'italic' },
    assetPickVia: { fontSize: 12, color: colors.textMuted },
    vetoWindowText: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.xs },
    cardNotes: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', marginTop: spacing.xxs },

    cardActions: {
        flexDirection: 'row',
        gap: 10,
        marginTop: 10,
        // On wide cards keep the button group at a tappable-but-sane width
        // instead of stretching each button across the whole card.
        maxWidth: 480,
    },
    actionBtn: {
        flex: 1,
        minHeight: 44,
        paddingVertical: 9,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionBtnAccept: { backgroundColor: colors.primary },
    actionBtnReject: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: uiColors.borderNeutral },
    actionBtnAcceptText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },
    actionBtnRejectText: { color: colors.textSecondary, fontWeight: fontWeight.semibold, fontSize: fontSize.md },
})
