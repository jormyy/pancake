import {
    View,
    Text,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    Alert,
    RefreshControl,
    Modal,
    ScrollView,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import {
    getMyTrades,
    acceptTrade,
    rejectTrade,
    withdrawTrade,
    Trade,
    TradeItem,
    TradePlayerItem,
    TradePickItem,
} from '@/lib/trades'
import { getRoster, dropPlayer, RosterPlayer } from '@/lib/roster'

type TabKey = 'inbox' | 'offers' | 'history'

const STATUS_LABELS: Record<string, string> = {
    pending: 'Pending',
    accepted: 'Accepted',
    rejected: 'Rejected',
    withdrawn: 'Withdrawn',
    completed: 'Completed',
    expired: 'Expired',
    vetoed: 'Vetoed',
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
    pending: { bg: '#FEF3C7', text: '#D97706' },
    accepted: { bg: '#D1FAE5', text: '#065F46' },
    rejected: { bg: '#FEE2E2', text: '#991B1B' },
    withdrawn: { bg: '#F3F4F6', text: '#6B7280' },
    completed: { bg: '#D1FAE5', text: '#065F46' },
    expired: { bg: '#F3F4F6', text: '#6B7280' },
    vetoed: { bg: '#FEE2E2', text: '#991B1B' },
}

const ItemSeparator = () => <View style={styles.separator} />

const ListEmpty = () => (
    <View style={styles.empty}>
        <Text style={styles.emptyText}>No trades to show.</Text>
    </View>
)

function itemLabel(item: TradeItem): string {
    if (item.kind === 'player') {
        return item.playerName
    }
    return `${item.seasonYear} Rd ${item.round} (via ${item.originalTeamName})`
}

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
                items.map((item, idx) => (
                    <TradeItemLine
                        key={item.kind === 'player' ? item.playerId : item.pickId}
                        item={item}
                    />
                ))
            )}
        </View>
    )
}

function TradeCard({
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

    // From MY perspective:
    // - I receive: if I'm proposer → recipientGives; if I'm recipient → proposerGives
    // - I give: if I'm proposer → proposerGives; if I'm recipient → recipientGives
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
                // Need to drop players first
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
                <ActivityIndicator color="#F97316" style={{ marginTop: 12 }} />
            ) : (
                <>
                    {tab === 'inbox' && trade.status === 'pending' && (
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
                    {tab === 'offers' && trade.status === 'pending' && (
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

            {/* Drop picker modal */}
            <Modal visible={dropPickerVisible} transparent animationType="slide">
                <View style={styles.modalOverlay}>
                    <View style={styles.modalSheet}>
                        <Text style={styles.modalTitle}>Drop {remainingDrops} player{remainingDrops !== 1 ? 's' : ''} to accept</Text>
                        <Text style={styles.modalSubtitle}>
                            Accepting this trade would exceed your {rosterSize}-player roster limit.
                        </Text>
                        <ScrollView style={styles.modalScroll}>
                            {myRoster.map((rp) => (
                                <View key={rp.id} style={styles.dropRow}>
                                    <View style={styles.dropPlayerInfo}>
                                        <Text style={styles.dropPlayerName}>{rp.players.display_name}</Text>
                                        <Text style={styles.dropPlayerMeta}>
                                            {[rp.players.position, rp.players.nba_team].filter(Boolean).join(' · ')}
                                        </Text>
                                    </View>
                                    <Pressable
                                        style={styles.dropBtn}
                                        onPress={() => handleDropAndAccept(rp.id)}
                                        disabled={dropping !== null}
                                    >
                                        {dropping === rp.id ? (
                                            <ActivityIndicator size="small" color="#fff" />
                                        ) : (
                                            <Text style={styles.dropBtnText}>Drop</Text>
                                        )}
                                    </Pressable>
                                </View>
                            ))}
                        </ScrollView>
                        <Pressable
                            style={styles.modalCancelBtn}
                            onPress={() => setDropPickerVisible(false)}
                        >
                            <Text style={styles.modalCancelText}>Cancel</Text>
                        </Pressable>
                    </View>
                </View>
            </Modal>
        </View>
    )
}

export default function TradesScreen() {
    const { push, back } = useRouter()
    const { user } = useAuth()
    const { current } = useLeagueContext()

    const league = current?.leagues as any
    const myMemberId = current?.id ?? ''
    const leagueId = league?.id ?? ''
    const rosterSize: number = league?.roster_size ?? 20

    const [tab, setTab] = useState<TabKey>('inbox')
    const [trades, setTrades] = useState<Trade[]>([])
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)

    const load = useCallback(async () => {
        if (!myMemberId || !leagueId) return
        try {
            const data = await getMyTrades(myMemberId, leagueId)
            setTrades(data)
        } catch (e) {
            console.error(e)
        } finally {
            setLoading(false)
            setRefreshing(false)
        }
    }, [myMemberId, leagueId])

    useEffect(() => {
        load()
    }, [load])

    function onRefresh() {
        setRefreshing(true)
        load()
    }

    // Filter by tab
    const filteredTrades = trades.filter((t) => {
        if (tab === 'inbox') {
            return t.recipientMemberId === myMemberId && t.status === 'pending'
        }
        if (tab === 'offers') {
            return t.proposerMemberId === myMemberId && t.status === 'pending'
        }
        // history: all non-pending
        return t.status !== 'pending'
    })

    const TABS: { key: TabKey; label: string }[] = [
        { key: 'inbox', label: 'Inbox' },
        { key: 'offers', label: 'My Offers' },
        { key: 'history', label: 'History' },
    ]

    const pendingInboxCount = trades.filter(
        (t) => t.recipientMemberId === myMemberId && t.status === 'pending',
    ).length

    return (
        <SafeAreaView style={styles.container} edges={['top']}>
            {/* Header */}
            <View style={styles.header}>
                <View style={{ width: 60 }} />
                <Text style={styles.headerTitle}>Trades</Text>
                <View style={styles.headerRight}>
                    <Pressable
                        style={styles.proposeBtn}
                        onPress={() => push('/(modals)/propose-trade')}
                    >
                        <Text style={styles.proposeBtnText}>Propose</Text>
                    </Pressable>
                    <Pressable onPress={() => back()} style={styles.doneBtn}>
                        <Text style={styles.doneBtnText}>Done</Text>
                    </Pressable>
                </View>
            </View>

            {/* Tab switcher */}
            <View style={styles.tabRow}>
                {TABS.map((t) => {
                    const active = tab === t.key
                    const badge = t.key === 'inbox' && pendingInboxCount > 0 ? pendingInboxCount : null
                    return (
                        <Pressable
                            key={t.key}
                            style={[styles.tabChip, active && styles.tabChipActive]}
                            onPress={() => setTab(t.key)}
                        >
                            <Text style={[styles.tabChipText, active && styles.tabChipTextActive]}>
                                {t.label}
                                {badge ? ` (${badge})` : ''}
                            </Text>
                        </Pressable>
                    )
                })}
            </View>

            {loading ? (
                <ActivityIndicator color="#F97316" style={{ marginTop: 32 }} />
            ) : (
                <FlashList
                    data={filteredTrades}
                    keyExtractor={(t) => t.id}
                    contentContainerStyle={styles.listContent}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={onRefresh}
                            tintColor="#F97316"
                        />
                    }
                    ItemSeparatorComponent={ItemSeparator}
                    ListEmptyComponent={ListEmpty}
                    renderItem={({ item }) => (
                        <TradeCard
                            trade={item}
                            myMemberId={myMemberId}
                            leagueId={leagueId}
                            rosterSize={rosterSize}
                            tab={tab}
                            onAction={load}
                        />
                    )}
                />
            )}
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#fff' },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    headerTitle: { fontSize: 17, fontWeight: '700' },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    proposeBtn: {
        backgroundColor: '#F97316',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
        borderCurve: 'continuous' as const,
    },
    proposeBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
    doneBtn: { paddingVertical: 6, paddingHorizontal: 4 },
    doneBtnText: { fontSize: 16, color: '#F97316', fontWeight: '600' },

    tabRow: {
        flexDirection: 'row',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    tabChip: {
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 20,
        borderCurve: 'continuous' as const,
        backgroundColor: '#f3f3f3',
    },
    tabChipActive: { backgroundColor: '#F97316' },
    tabChipText: { fontSize: 13, fontWeight: '600', color: '#555' },
    tabChipTextActive: { color: '#fff' },

    listContent: { paddingHorizontal: 16, paddingVertical: 12 },
    separator: { height: 12 },

    card: {
        borderWidth: 1,
        borderColor: '#e5e7eb',
        borderRadius: 12,
        borderCurve: 'continuous' as const,
        padding: 14,
        backgroundColor: '#fff',
        gap: 4,
    },
    cardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 6,
    },
    cardOpponent: { fontSize: 15, fontWeight: '700', color: '#111', flex: 1 },
    statusBadge: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        borderCurve: 'continuous' as const,
    },
    statusText: { fontSize: 11, fontWeight: '700' },

    assetBlock: { marginBottom: 4 },
    assetLabel: { fontSize: 12, fontWeight: '600', color: '#333', marginBottom: 2 },
    assetEmpty: { fontSize: 13, color: '#aaa' },
    assetPlayer: { fontSize: 13, color: '#555' },
    assetPick: { fontSize: 13, color: '#555', fontStyle: 'italic' },
    assetPickVia: { fontSize: 12, color: '#999' },

    cardNotes: { fontSize: 12, color: '#888', fontStyle: 'italic', marginTop: 2 },

    cardActions: {
        flexDirection: 'row',
        gap: 10,
        marginTop: 10,
    },
    actionBtn: {
        flex: 1,
        paddingVertical: 9,
        borderRadius: 8,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
    },
    actionBtnAccept: { backgroundColor: '#F97316' },
    actionBtnReject: { backgroundColor: '#f3f3f3', borderWidth: 1, borderColor: '#e5e7eb' },
    actionBtnAcceptText: { color: '#fff', fontWeight: '700', fontSize: 14 },
    actionBtnRejectText: { color: '#555', fontWeight: '600', fontSize: 14 },

    empty: { alignItems: 'center', paddingVertical: 48 },
    emptyText: { fontSize: 14, color: '#aaa', textAlign: 'center' },

    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.4)',
        justifyContent: 'flex-end',
    },
    modalSheet: {
        backgroundColor: '#fff',
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        borderCurve: 'continuous' as const,
        paddingTop: 20,
        paddingHorizontal: 16,
        paddingBottom: 32,
        maxHeight: '75%',
    },
    modalTitle: { fontSize: 17, fontWeight: '700', color: '#111', marginBottom: 4 },
    modalSubtitle: { fontSize: 13, color: '#888', marginBottom: 14 },
    modalScroll: { flexGrow: 0 },
    dropRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: '#f3f3f3',
        gap: 10,
    },
    dropPlayerInfo: { flex: 1 },
    dropPlayerName: { fontSize: 14, fontWeight: '600', color: '#111' },
    dropPlayerMeta: { fontSize: 12, color: '#888', marginTop: 1 },
    dropBtn: {
        backgroundColor: '#EF4444',
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 8,
        borderCurve: 'continuous' as const,
        minWidth: 60,
        alignItems: 'center',
    },
    dropBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
    modalCancelBtn: {
        marginTop: 14,
        paddingVertical: 13,
        borderRadius: 10,
        borderCurve: 'continuous' as const,
        backgroundColor: '#f3f3f3',
        alignItems: 'center',
    },
    modalCancelText: { fontSize: 15, fontWeight: '600', color: '#555' },
})
