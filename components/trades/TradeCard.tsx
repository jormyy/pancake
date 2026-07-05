import { View, Text, StyleSheet } from 'react-native'
import { useState } from 'react'
import { useRouter } from 'expo-router'
import { TRADE_STATUS_COLORS, colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { Trade, TradeItem, acceptTrade, rejectTrade, vetoTrade, withdrawTrade } from '@/lib/trades'
import { getRoster, RosterPlayer } from '@/lib/roster'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { showAlert, confirmAction, getErrorMessage } from '@/lib/alert'
import { MotionPressable, MotionView } from '@/components/Motion'
import { Avatar } from '@/components/Avatar'
import { playerHeadshotUrl } from '@/lib/format'
import { getPositionColor } from '@/constants/positions'

export type TabKey = 'picks' | 'offers' | 'history' | 'block'

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

function TradeItemLine({ item }: { item: TradeItem }) {
    if (item.kind === 'player') {
        return (
            <View style={styles.assetPlayerRow}>
                <Avatar
                    name={item.playerName}
                    uri={playerHeadshotUrl(item.nbaId) ?? undefined}
                    color={getPositionColor(item.position, colors.bgMuted)}
                    textColor={colors.textSecondary}
                    size={26}
                />
                <View style={styles.assetPlayerCopy}>
                    <Text style={styles.assetPlayer} numberOfLines={1}>{item.playerName}</Text>
                    <Text style={styles.assetPlayerMeta} numberOfLines={1}>
                        {[item.nbaTeam, item.position].filter(Boolean).join(' · ')}
                    </Text>
                </View>
            </View>
        )
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
                items.map((item) => (
                    <TradeItemLine
                        key={item.kind === 'player' ? item.playerId : item.pickId}
                        item={item}
                    />
                ))
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
    onAction,
}: {
    trade: Trade
    myMemberId: string
    leagueId: string
    rosterSize: number
    tab: TabKey
    onAction: () => void
}) {
    const { push } = useRouter()
    const isProposer = trade.proposerMemberId === myMemberId
    const isRecipient = trade.recipientMemberId === myMemberId
    const isTradeParty = isProposer || isRecipient
    const opponentName = isProposer
        ? trade.recipientTeamName
        : isRecipient
            ? trade.proposerTeamName
            : `${trade.proposerTeamName} vs ${trade.recipientTeamName}`

    const iReceive = isProposer ? trade.recipientGives : trade.proposerGives
    const iGive = isProposer ? trade.proposerGives : trade.recipientGives
    const iReceiveFaab = isProposer ? trade.recipientFaabAmount : trade.proposerFaabAmount
    const iGiveFaab = isProposer ? trade.proposerFaabAmount : trade.recipientFaabAmount
    const receiveLabel = isTradeParty
        ? 'You receive:'
        : `${trade.recipientTeamName} receives:`
    const giveLabel = isTradeParty
        ? 'You give:'
        : `${trade.proposerTeamName} receives:`

    const statusStyle = STATUS_COLORS[trade.status] ?? STATUS_COLORS.pending
    const canVeto = tab === 'offers' && !isTradeParty && trade.status === 'accepted' && !trade.myVetoed
    const alreadyVetoed = tab === 'offers' && !isTradeParty && trade.status === 'accepted' && trade.myVetoed
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
            {alreadyVetoed ? <Text style={styles.vetoWindowText}>Your veto has been recorded.</Text> : null}

            <AssetList items={iReceive} label={receiveLabel} />
            {iReceiveFaab > 0 ? <Text style={styles.assetPlayer}>FAAB ${iReceiveFaab}</Text> : null}
            <AssetList items={iGive} label={giveLabel} />
            {iGiveFaab > 0 ? <Text style={styles.assetPlayer}>FAAB ${iGiveFaab}</Text> : null}

            {trade.notes ? <Text style={styles.cardNotes}>{trade.notes}</Text> : null}

            {tab === 'offers' && !isProposer && trade.status === 'pending' && (
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
        borderColor: palette.gray300,
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
    assetPlayerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 2 },
    assetPlayerCopy: { flex: 1, minWidth: 0 },
    assetPlayer: { fontSize: fontSize.sm, color: colors.textSecondary },
    assetPlayerMeta: { fontSize: fontSize.xs, color: colors.textMuted },
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
        paddingVertical: 9,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
    },
    actionBtnAccept: { backgroundColor: colors.primary },
    actionBtnReject: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: palette.gray300 },
    actionBtnAcceptText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },
    actionBtnRejectText: { color: colors.textSecondary, fontWeight: fontWeight.semibold, fontSize: fontSize.md },
})
