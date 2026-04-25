import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert } from 'react-native'
import { useState } from 'react'
import { TRADE_STATUS_COLORS, colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { Trade, TradeItem, acceptTrade, rejectTrade, withdrawTrade } from '@/lib/trades'
import { getRoster, dropPlayer, RosterPlayer } from '@/lib/roster'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'

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
    const opponentName = isProposer ? trade.recipientTeamName : trade.proposerTeamName

    const iReceive = isProposer ? trade.recipientGives : trade.proposerGives
    const iGive = isProposer ? trade.proposerGives : trade.recipientGives

    const statusStyle = STATUS_COLORS[trade.status] ?? STATUS_COLORS.pending

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
            const activeCount = roster.filter((p) => !p.is_on_ir).length
            const incomingPlayers = iReceive.filter((i) => i.kind === 'player').length
            const outgoingPlayers = iGive.filter((i) => i.kind === 'player').length
            const newCount = activeCount - outgoingPlayers + incomingPlayers
            const overflow = newCount - rosterSize

            if (overflow > 0) {
                const activeRoster = roster.filter((p) => !p.is_on_ir)
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
        setDropping(rosterPlayerId)
        try {
            await dropPlayer(rosterPlayerId)
            const next = new Set(droppedIds)
            next.add(rosterPlayerId)
            setDroppedIds(next)
            setMyRoster((prev) => prev.filter((p) => p.id !== rosterPlayerId))

            if (next.size >= neededDrops) {
                setDropPickerVisible(false)
                setActing(true)
                try {
                    await acceptTrade(trade.id, myMemberId)
                    onAction()
                } catch (e: any) {
                    Alert.alert('Error', e.message ?? 'Could not accept trade.')
                } finally {
                    setActing(false)
                }
            }
        } catch (e: any) {
            Alert.alert('Error', e.message ?? 'Could not drop player.')
        } finally {
            setDropping(null)
        }
    }

    async function handleReject() {
        Alert.alert('Reject Trade', 'Are you sure you want to reject this trade?', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Reject',
                style: 'destructive',
                onPress: async () => {
                    setActing(true)
                    try {
                        await rejectTrade(trade.id, myMemberId)
                        onAction()
                    } catch (e: any) {
                        Alert.alert('Error', e.message ?? 'Could not reject trade.')
                    } finally {
                        setActing(false)
                    }
                },
            },
        ])
    }

    async function handleWithdraw() {
        Alert.alert('Withdraw Trade', 'Are you sure you want to withdraw this offer?', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Withdraw',
                style: 'destructive',
                onPress: async () => {
                    setActing(true)
                    try {
                        await withdrawTrade(trade.id, myMemberId)
                        onAction()
                    } catch (e: any) {
                        Alert.alert('Error', e.message ?? 'Could not withdraw trade.')
                    } finally {
                        setActing(false)
                    }
                },
            },
        ])
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

            <AssetList items={iReceive} label="You receive:" />
            <AssetList items={iGive} label="You give:" />

            {trade.notes ? <Text style={styles.cardNotes}>"{trade.notes}"</Text> : null}

            {acting ? (
                <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.lg }} />
            ) : (
                <>
                    {tab === 'offers' && !isProposer && trade.status === 'pending' && (
                        <View style={styles.cardActions}>
                            <Pressable
                                style={[styles.actionBtn, styles.actionBtnAccept]}
                                onPress={handleAccept}
                            >
                                <Text style={styles.actionBtnAcceptText}>Accept</Text>
                            </Pressable>
                            <Pressable
                                style={[styles.actionBtn, styles.actionBtnReject]}
                                onPress={handleReject}
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
                            >
                                <Text style={styles.actionBtnRejectText}>Withdraw</Text>
                            </Pressable>
                        </View>
                    )}
                </>
            )}

            <DropPlayerPickerModal
                visible={dropPickerVisible}
                title={`Drop ${remainingDrops} player${remainingDrops !== 1 ? 's' : ''} to accept`}
                subtitle={`Accepting this trade would exceed your ${rosterSize}-player roster limit.`}
                roster={myRoster}
                dropping={dropping}
                onDrop={(rp) => handleDropAndAccept(rp.id)}
                onCancel={() => setDropPickerVisible(false)}
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
