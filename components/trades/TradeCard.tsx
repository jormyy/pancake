import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert } from 'react-native'
import { useState } from 'react'
import { TRADE_STATUS_COLORS, colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { Trade, TradeItem, acceptTrade, rejectTrade, vetoTrade, withdrawTrade } from '@/lib/trades'
import { getRoster, dropPlayer, RosterPlayer } from '@/lib/roster'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { confirmAction } from '@/lib/alert'

export type TabKey = 'picks' | 'offers' | 'history'

const STATUS_LABELS: Record<string, string> = {
    pending: 'Pending',
    accepted: 'Accepted',
    rejected: 'Rejected',
    withdrawn: 'Withdrawn',
    completed: 'Completed',
    expired: 'Expired',
    vetoed: 'Vetoed',
}

const STATUS_COLORS = TRADE_STATUS_COLORS

function TradeItemLine({ item }: { item: TradeItem }) {
    if (item.kind === 'player') {
        return <Text style={styles.assetPlayer}>{item.playerName}</Text>
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
                // Accept the trade FIRST, then prompt for drops. The backend
                // `accept_trade_atomic` only locks the trade assets and starts
                // the 24h veto window — it does not enforce roster size, and
                // assets do not move until `complete_accepted_trade_atomic`
                // runs after the veto window. Accepting before dropping means
                // a network failure or modal cancel leaves the roster intact
                // (no orphan drops). The user has the full veto window to
                // drop overflow players manually if they dismiss the modal.
                await acceptTrade(trade.id, myMemberId)

                const activeRoster = roster.filter((p) => !p.is_on_ir && !p.is_on_taxi)
                setMyRoster(activeRoster)
                setNeededDrops(overflow)
                setDroppedIds(new Set())
                setActing(false)
                setDropPickerVisible(true)
                return
            }

            await acceptTrade(trade.id, myMemberId)
            onAction()
        } catch (e: any) {
            Alert.alert('Error', e.message ?? 'Could not accept trade.')
        } finally {
            setActing(false)
        }
    }

    async function handleDropAndAccept(rosterPlayerId: string) {
        // Trade has already been accepted in `handleAccept`. These drops just
        // make room on the recipient's roster before the trade completes at
        // the end of the veto window. Drop failures are non-fatal: the trade
        // remains accepted and the user can finish dropping from the roster
        // screen. There is no longer any path where drops orphan a pending
        // trade, because accept always runs first.
        setDropping(rosterPlayerId)
        try {
            await dropPlayer(rosterPlayerId)
            const next = new Set(droppedIds)
            next.add(rosterPlayerId)
            setDroppedIds(next)
            setMyRoster((prev) => prev.filter((p) => p.id !== rosterPlayerId))

            if (next.size >= neededDrops) {
                setDropPickerVisible(false)
                onAction()
            }
        } catch (e: any) {
            Alert.alert('Error', e.message ?? 'Could not drop player.')
        } finally {
            setDropping(null)
        }
    }

    function handleCancelDropPicker() {
        // Trade is already accepted at this point. Closing the modal leaves
        // the user over-cap but still owning every player they had before;
        // they can finish dropping from the roster screen before the veto
        // window closes. Refresh parent so the new "accepted" status renders.
        setDropPickerVisible(false)
        if (droppedIds.size < neededDrops) {
            const remaining = neededDrops - droppedIds.size
            Alert.alert(
                'Trade accepted',
                `You still need to drop ${remaining} player${remaining !== 1 ? 's' : ''} from your roster before the veto window closes.`,
            )
        }
        onAction()
    }

    function handleReject() {
        confirmAction('Reject Trade', 'Are you sure you want to reject this trade?', () => {
            void (async () => {
                setActing(true)
                try {
                    await rejectTrade(trade.id, myMemberId)
                    onAction()
                } catch (e: any) {
                    Alert.alert('Error', e.message ?? 'Could not reject trade.')
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
                } catch (e: any) {
                    Alert.alert('Error', e.message ?? 'Could not withdraw trade.')
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
                } catch (e: any) {
                    Alert.alert('Error', e.message ?? 'Could not veto trade.')
                } finally {
                    setActing(false)
                }
            })()
        }, 'Veto')
    }

    const remainingDrops = neededDrops - droppedIds.size

    return (
        <View style={styles.card}>
            <View style={styles.cardHeader}>
                <Text style={styles.cardOpponent}>{opponentName}</Text>
                <View style={[styles.statusBadge, { backgroundColor: statusStyle.bg }]}>
                    <Text style={[styles.statusText, { color: statusStyle.text }]}>
                        {STATUS_LABELS[trade.status] ?? trade.status}
                    </Text>
                </View>
            </View>

            {vetoWindowText ? <Text style={styles.vetoWindowText}>{vetoWindowText}</Text> : null}
            {alreadyVetoed ? <Text style={styles.vetoWindowText}>Your veto has been recorded.</Text> : null}

            <AssetList items={iReceive} label={receiveLabel} />
            <AssetList items={iGive} label={giveLabel} />

            {trade.notes ? <Text style={styles.cardNotes}>{trade.notes}</Text> : null}

            {acting ? (
                <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.lg }} />
            ) : (
                <>
                    {tab === 'offers' && !isProposer && trade.status === 'pending' && (
                        <View style={styles.cardActions}>
                            <Pressable
                                style={[styles.actionBtn, styles.actionBtnAccept]}
                                onPress={handleAccept}
                                accessibilityRole="button"
                                accessibilityLabel={`Accept trade with ${opponentName}`}
                            >
                                <Text style={styles.actionBtnAcceptText}>Accept</Text>
                            </Pressable>
                            <Pressable
                                style={[styles.actionBtn, styles.actionBtnReject]}
                                onPress={handleReject}
                                accessibilityRole="button"
                                accessibilityLabel={`Reject trade with ${opponentName}`}
                            >
                                <Text style={styles.actionBtnRejectText}>Reject</Text>
                            </Pressable>
                        </View>
                    )}
                    {tab === 'offers' && isProposer && trade.status === 'pending' && (
                        <View style={styles.cardActions}>
                            <Pressable
                                style={[styles.actionBtn, styles.actionBtnReject]}
                                onPress={handleWithdraw}
                                accessibilityRole="button"
                                accessibilityLabel={`Withdraw trade with ${opponentName}`}
                            >
                                <Text style={styles.actionBtnRejectText}>Withdraw</Text>
                            </Pressable>
                        </View>
                    )}
                    {canVeto && (
                        <View style={styles.cardActions}>
                            <Pressable
                                style={[styles.actionBtn, styles.actionBtnReject]}
                                onPress={handleVeto}
                                accessibilityRole="button"
                                accessibilityLabel={`Veto trade between ${trade.proposerTeamName} and ${trade.recipientTeamName}`}
                            >
                                <Text style={styles.actionBtnRejectText}>Veto</Text>
                            </Pressable>
                        </View>
                    )}
                </>
            )}

            <DropPlayerPickerModal
                visible={dropPickerVisible}
                title={`Drop ${remainingDrops} player${remainingDrops !== 1 ? 's' : ''} to make room`}
                subtitle={`Trade accepted. You must drop ${remainingDrops} player${remainingDrops !== 1 ? 's' : ''} before the veto window closes to stay under your ${rosterSize}-player roster limit.`}
                roster={myRoster}
                dropping={dropping}
                onDrop={(rp) => handleDropAndAccept(rp.id)}
                onCancel={handleCancelDropPicker}
            />
        </View>
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
    assetLabel: { fontSize: 12, fontWeight: fontWeight.semibold, color: palette.gray900, marginBottom: spacing.xxs },
    assetEmpty: { fontSize: fontSize.sm, color: colors.textPlaceholder },
    assetPlayer: { fontSize: fontSize.sm, color: colors.textSecondary },
    assetPick: { fontSize: fontSize.sm, color: colors.textSecondary, fontStyle: 'italic' },
    assetPickVia: { fontSize: 12, color: palette.gray650 },

    vetoWindowText: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.xs },
    cardNotes: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', marginTop: spacing.xxs },

    cardActions: {
        flexDirection: 'row',
        gap: 10,
        marginTop: 10,
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
