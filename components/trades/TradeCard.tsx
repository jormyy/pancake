import { View, Text, StyleSheet } from 'react-native'
import { useState } from 'react'
import { useRouter } from 'expo-router'
import { INJURY_COLORS, TRADE_STATUS_COLORS, colors, fontSize, fontWeight, radii, spacing, uiColors } from '@/constants/tokens'
import { Trade, TradeItem, acceptTrade, needsMemberAcceptance, rejectTrade, vetoTrade, withdrawTrade } from '@/lib/trades'
import { getRoster, RosterPlayer } from '@/lib/roster'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { showAlert, confirmAction, getErrorMessage } from '@/lib/alert'
import { MotionPressable, MotionView } from '@/components/Motion'
import { Avatar } from '@/components/Avatar'
import { playerHeadshotUrl } from '@/lib/format'
import { playerEligiblePositions, playerSeasonContextText } from '@/lib/player-context'
import { PosTag } from '@/components/PosTag'
import { Badge } from '@/components/Badge'

export type TabKey = 'picks' | 'offers' | 'history' | 'block' | 'leagueBlock'
type TradeVetoMode = 'disabled' | 'commissioner' | 'member_vote'

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

function tradeMemberLabel(trade: Trade, memberId: string | null | undefined, myMemberId: string) {
    if (!memberId) return 'Unknown team'
    if (memberId === myMemberId) return 'You'

    const participant = trade.participants.find((entry) => entry.memberId === memberId)
    if (participant) return participant.teamName
    if (memberId === trade.proposerMemberId) return trade.proposerTeamName
    if (memberId === trade.recipientMemberId) return trade.recipientTeamName
    return 'Unknown team'
}

function MultiTeamRouteList({ trade, myMemberId }: { trade: Trade; myMemberId: string }) {
    return (
        <View style={styles.multiRouteList}>
            <Text style={styles.assetLabel}>Deal overview</Text>
            {trade.participants.length === 0 ? (
                <Text style={styles.assetEmpty}>Nothing</Text>
            ) : (
                trade.participants.map((participant) => {
                    const incoming = trade.routedItems.filter((item) => item.toMemberId === participant.memberId)
                    return (
                    <View
                        key={participant.memberId}
                        style={styles.routeGroup}
                    >
                        <View style={styles.routeTitleRow}>
                            <Text style={styles.routeTitle} numberOfLines={1}>
                                {participant.memberId === myMemberId
                                    ? 'You receive'
                                    : `${tradeMemberLabel(trade, participant.memberId, myMemberId)} receives`}
                            </Text>
                            <Text style={[styles.routeAcceptance, participant.acceptedAt && styles.routeAcceptanceComplete]}>
                                {participant.acceptedAt ? 'Accepted' : 'Waiting'}
                            </Text>
                        </View>
                        {incoming.length === 0 ? (
                            <Text style={styles.assetEmpty}>No incoming assets</Text>
                        ) : incoming.map((item, index) => (
                            <View key={tradeItemKey(item, index)} style={styles.routedAsset}>
                                <TradeItemLine item={item} />
                                <Text style={styles.routeSource} numberOfLines={1}>
                                    From {tradeMemberLabel(trade, item.fromMemberId, myMemberId)}
                                </Text>
                            </View>
                        ))}
                    </View>
                    )
                })
            )}
        </View>
    )
}

export function TradeCard({
    trade,
    myMemberId,
    leagueId,
    rosterSize,
    tab,
    tradeVetoMode = 'member_vote',
    isCommissioner = false,
    onAction,
}: {
    trade: Trade
    myMemberId: string
    leagueId: string
    rosterSize: number
    tab: TabKey
    tradeVetoMode?: TradeVetoMode
    isCommissioner?: boolean
    onAction: () => void
}) {
    const { push } = useRouter()
    const isProposer = trade.proposerMemberId === myMemberId
    const isRecipient = trade.recipientMemberId === myMemberId
    const participants = trade.participants ?? []
    const isMultiParticipant = participants.some((participant) => participant.memberId === myMemberId)
    const isTradeParty = isProposer || isRecipient || isMultiParticipant
    const opponentName = trade.isMultiTeam && participants.length > 0
        ? `${participants.length}-team trade`
        : isProposer
        ? trade.recipientTeamName
        : isRecipient
            ? trade.proposerTeamName
            : `${trade.proposerTeamName} vs ${trade.recipientTeamName}`

    const iReceive = trade.isMultiTeam
        ? trade.routedItems.filter((item) => item.toMemberId === myMemberId)
        : isProposer ? trade.recipientGives : trade.proposerGives
    const iGive = trade.isMultiTeam
        ? trade.routedItems.filter((item) => item.fromMemberId === myMemberId)
        : isProposer ? trade.proposerGives : trade.recipientGives
    const iReceiveFaab = trade.isMultiTeam ? 0 : isProposer ? trade.recipientFaabAmount : trade.proposerFaabAmount
    const iGiveFaab = trade.isMultiTeam ? 0 : isProposer ? trade.proposerFaabAmount : trade.recipientFaabAmount
    const receiveLabel = isTradeParty
        ? 'You receive:'
        : `${trade.recipientTeamName} receives:`
    const giveLabel = isTradeParty
        ? 'You give:'
        : `${trade.proposerTeamName} receives:`

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

    const [acting, setActing] = useState(false)
    const [dropPickerVisible, setDropPickerVisible] = useState(false)
    const [myRoster, setMyRoster] = useState<RosterPlayer[]>([])
    const [droppedIds, setDroppedIds] = useState<Set<string>>(new Set())
    const [neededDrops, setNeededDrops] = useState(0)
    const [dropping, setDropping] = useState<string | null>(null)

    async function handleAccept() {
        setActing(true)
        try {
            const roster = await getRoster(myMemberId, leagueId)
            const activeCount = roster.filter((p) => !p.is_on_ir && !p.is_on_taxi).length
            const incomingPlayers = iReceive.filter((i) => i.kind === 'player').length
            const outgoingPlayers = iGive.filter((i) => i.kind === 'player').length
            const newCount = activeCount - outgoingPlayers + incomingPlayers
            const overflow = newCount - rosterSize

            if (overflow > 0) {
                const outgoingPlayerIds = new Set(
                    iGive.filter((item) => item.kind === 'player').map((item) => item.playerId),
                )
                const activeRoster = roster.filter(
                    (player) =>
                        !player.is_on_ir &&
                        !player.is_on_taxi &&
                        !outgoingPlayerIds.has(player.players?.id ?? ''),
                )
                setMyRoster(activeRoster)
                setNeededDrops(overflow)
                setDroppedIds(new Set())
                setActing(false)
                setDropPickerVisible(true)
                return
            }

            await acceptTrade(trade.id, myMemberId)
            onAction()
        } catch (e) {
            showAlert('Error', getErrorMessage(e) ?? 'Could not accept trade.')
        } finally {
            setActing(false)
        }
    }

    async function handleDropAndAccept(rosterPlayerId: string) {
        const next = new Set(droppedIds)
        next.add(rosterPlayerId)
        setDroppedIds(next)
        setMyRoster((prev) => prev.filter((p) => p.id !== rosterPlayerId))

        if (next.size < neededDrops) return

        setDropping(rosterPlayerId)
        try {
            await acceptTrade(trade.id, myMemberId, [...next])
            setDropPickerVisible(false)
            onAction()
        } catch (e) {
            showAlert('Error', getErrorMessage(e) ?? 'Could not accept trade.')
        } finally {
            setDropping(null)
        }
    }

    function handleCancelDropPicker() {
        setDropPickerVisible(false)
        setDroppedIds(new Set())
        setMyRoster([])
    }

    function handleReject() {
        confirmAction('Reject Trade', 'Are you sure you want to reject this trade?', () => {
            void (async () => {
                setActing(true)
                try {
                    await rejectTrade(trade.id, myMemberId)
                    onAction()
                } catch (e) {
                    showAlert('Error', getErrorMessage(e) ?? 'Could not reject trade.')
                } finally {
                    setActing(false)
                }
            })()
        }, 'Reject')
    }

    function handleWithdraw() {
        confirmAction('Withdraw Trade', 'Are you sure you want to withdraw this offer?', () => {
            void (async () => {
                setActing(true)
                try {
                    await withdrawTrade(trade.id, myMemberId)
                    onAction()
                } catch (e) {
                    showAlert('Error', getErrorMessage(e) ?? 'Could not withdraw trade.')
                } finally {
                    setActing(false)
                }
            })()
        }, 'Withdraw')
    }

    function handleVeto() {
        confirmAction('Veto Trade', 'Are you sure you want to veto this accepted trade?', () => {
            void (async () => {
                setActing(true)
                try {
                    await vetoTrade(trade.id, myMemberId)
                    onAction()
                } catch (e) {
                    showAlert('Error', getErrorMessage(e) ?? 'Could not veto trade.')
                } finally {
                    setActing(false)
                }
            })()
        }, 'Veto')
    }

    const remainingDrops = neededDrops - droppedIds.size

    return (
        <MotionView style={styles.card} preset="rise">
            <View style={styles.cardHeader}>
                <Text style={styles.cardOpponent}>{opponentName}</Text>
                <View style={[styles.statusBadge, { backgroundColor: statusStyle.bg }]}>
                    <Text style={[styles.statusText, { color: statusStyle.text }]}>
                        {STATUS_LABELS[trade.status] ?? trade.status}
                    </Text>
                </View>
            </View>

            {vetoWindowText ? <Text style={styles.vetoWindowText}>{vetoWindowText}</Text> : null}
            {expiresText ? <Text style={styles.vetoWindowText}>{expiresText}</Text> : null}
            {trade.version > 1 ? <Text style={styles.vetoWindowText}>Version {trade.version}</Text> : null}
            {participantAcceptanceText ? <Text style={styles.vetoWindowText}>{participantAcceptanceText}</Text> : null}
            {alreadyVetoed ? <Text style={styles.vetoWindowText}>Your veto has been recorded.</Text> : null}

            {trade.isMultiTeam ? (
                <MultiTeamRouteList trade={trade} myMemberId={myMemberId} />
            ) : (
                <>
                    <AssetList items={iReceive} label={receiveLabel} />
                    {iReceiveFaab > 0 ? <Text style={styles.assetPlayer}>FAAB ${iReceiveFaab}</Text> : null}
                    <AssetList items={iGive} label={giveLabel} />
                    {iGiveFaab > 0 ? <Text style={styles.assetPlayer}>FAAB ${iGiveFaab}</Text> : null}
                </>
            )}

            {trade.notes ? <Text style={styles.cardNotes}>{trade.notes}</Text> : null}

            {canRespond && (
                <View style={styles.cardActions}>
                    <MotionPressable
                        style={[styles.actionBtn, styles.actionBtnAccept]}
                        onPress={handleAccept}
                        disabled={acting}
                        accessibilityRole="button"
                        accessibilityLabel={`Accept trade with ${opponentName}`}
                        pressedScale={0.94}
                    >
                        <Text style={styles.actionBtnAcceptText}>Accept</Text>
                    </MotionPressable>
                    {canReject ? (
                        <MotionPressable
                            style={[styles.actionBtn, styles.actionBtnReject]}
                            onPress={handleReject}
                            disabled={acting}
                            accessibilityRole="button"
                            accessibilityLabel={`Reject trade with ${opponentName}`}
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
                        pressedScale={0.94}
                    >
                        <Text style={styles.actionBtnAcceptText}>Edit</Text>
                    </MotionPressable>
                    <MotionPressable
                        style={[styles.actionBtn, styles.actionBtnReject]}
                        onPress={handleWithdraw}
                        disabled={acting}
                        accessibilityRole="button"
                        accessibilityLabel={`Withdraw trade with ${opponentName}`}
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
                        onPress={handleVeto}
                        disabled={acting}
                        accessibilityRole="button"
                        accessibilityLabel={`Veto trade between ${trade.proposerTeamName} and ${trade.recipientTeamName}`}
                        pressedScale={0.94}
                    >
                        <Text style={styles.actionBtnRejectText}>Veto</Text>
                    </MotionPressable>
                </View>
            )}

            <DropPlayerPickerModal
                visible={dropPickerVisible}
                title={`Drop ${remainingDrops} player${remainingDrops !== 1 ? 's' : ''} to make room`}
                subtitle={`Select ${remainingDrops} player${remainingDrops !== 1 ? 's' : ''} to drop, then the trade will be accepted atomically.`}
                roster={myRoster}
                dropping={dropping}
                onDrop={(rp) => handleDropAndAccept(rp.id)}
                onCancel={handleCancelDropPicker}
            />
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
        backgroundColor: colors.bgScreen,
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
    cardOpponent: { fontSize: 15, fontWeight: fontWeight.bold, color: colors.textPrimary, flex: 1 },
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
    multiRouteList: { marginBottom: spacing.xs, gap: spacing.sm },
    routeGroup: {
        borderTopWidth: 1,
        borderTopColor: colors.borderLight,
        paddingTop: spacing.sm,
        gap: spacing.xs,
    },
    routeTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.sm,
    },
    routeTitle: { flex: 1, fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: fontWeight.bold },
    routeAcceptance: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: fontWeight.semibold },
    routeAcceptanceComplete: { color: uiColors.successText },
    routedAsset: { paddingLeft: spacing.sm },
    routeSource: { marginTop: 2, fontSize: fontSize.xs, color: colors.textMuted },

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
        paddingVertical: 9,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
    },
    actionBtnAccept: { backgroundColor: colors.primary },
    actionBtnReject: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: uiColors.borderNeutral },
    actionBtnAcceptText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },
    actionBtnRejectText: { color: colors.textSecondary, fontWeight: fontWeight.semibold, fontSize: fontSize.md },
})
