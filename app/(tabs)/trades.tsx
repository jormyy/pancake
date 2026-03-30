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
import { useCallback, useEffect, useMemo, useState } from 'react'
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
    getPicksForMember,
} from '@/lib/trades'
import { getRoster, dropPlayer, RosterPlayer } from '@/lib/roster'
import { TRADE_STATUS_COLORS, colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { ItemSeparator } from '@/components/ItemSeparator'
import { SectionHeader } from '@/components/SectionHeader'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { shortDateFmt } from '@/lib/format'

type TabKey = 'picks' | 'offers' | 'history'

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

type ListItem =
    | { _type: 'trade'; trade: Trade }
    | { _type: 'header'; label: string }
    | { _type: 'pick'; pick: TradePickItem }

function yearShort(year: number): string {
    return String(year).slice(2)
}

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
                                            <ActivityIndicator size="small" color={colors.textWhite} />
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

function PickItemRow({
    pick,
    myTeamName,
}: {
    pick: TradePickItem
    myTeamName: string
}) {
    const isOwn = pick.originalTeamName === myTeamName
    return (
        <View style={styles.pickRow}>
            <View style={styles.pickCircle}>
                <Text style={styles.pickCircleText}>{yearShort(pick.seasonYear)}</Text>
            </View>
            <View style={styles.pickInfo}>
                <Text style={styles.pickLabel}>{pick.seasonYear} Round {pick.round}</Text>
                {!isOwn ? (
                    <Text style={styles.pickMeta}>via {pick.originalTeamName}</Text>
                ) : null}
            </View>
        </View>
    )
}

export default function TradesScreen() {
    const { push } = useRouter()
    const { user } = useAuth()
    const { current } = useLeagueContext()

    const league = current?.leagues as any
    const myMemberId = current?.id ?? ''
    const leagueId = league?.id ?? ''
    const rosterSize: number = league?.roster_size ?? 20
    const myTeamName = current?.team_name ?? ''

    const [tab, setTab] = useState<TabKey>('picks')
    const [trades, setTrades] = useState<Trade[]>([])
    const [picks, setPicks] = useState<TradePickItem[]>([])
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)

    const { data: draftData, loading: draftLoading, refresh: loadDraft } = useFocusAsyncData(async () => {
        if (!current || !leagueId) return null
        try {
            const data = await getPicksForMember(current.id, leagueId)
            setPicks(data)
            return data
        } catch (e) {
            console.error(e)
            return null
        }
    }, [current, leagueId])

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
        loadDraft()
    }

    const incomingTrades = trades.filter(
        (t) => t.recipientMemberId === myMemberId && t.status === 'pending',
    )
    const outgoingTrades = trades.filter(
        (t) => t.proposerMemberId === myMemberId && t.status === 'pending',
    )
    const historyTrades = trades.filter((t) => t.status !== 'pending')

    const listData = useMemo<ListItem[]>(() => {
        const result: ListItem[] = []

        if (tab === 'picks') {
            if (picks.length === 0 && !loading) {
                result.push({ _type: 'header', label: '' })
            }
            picks.forEach((p) => result.push({ _type: 'pick', pick: p }))
        } else if (tab === 'offers') {
            result.push({ _type: 'header', label: 'Incoming' })
            incomingTrades.forEach((t) => result.push({ _type: 'trade', trade: t }))
            if (incomingTrades.length === 0 && !loading) {
                result.push({ _type: 'header', label: '' })
            }
            result.push({ _type: 'header', label: 'Outgoing' })
            outgoingTrades.forEach((t) => result.push({ _type: 'trade', trade: t }))
            if (outgoingTrades.length === 0 && !loading) {
                result.push({ _type: 'header', label: '' })
            }
        } else {
            result.push({ _type: 'header', label: 'Trade History' })
            historyTrades.forEach((t) => result.push({ _type: 'trade', trade: t }))
            if (historyTrades.length === 0 && !loading) {
                result.push({ _type: 'header', label: '' })
            }
        }

        return result
    }, [tab, incomingTrades, outgoingTrades, historyTrades, picks, loading])

    const TABS: { key: TabKey; label: string }[] = [
        { key: 'picks', label: 'Picks' },
        { key: 'offers', label: 'Offers' },
        { key: 'history', label: 'History' },
    ]

    const pendingInboxCount = incomingTrades.length

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>Trades</Text>
                <Pressable
                    style={styles.proposeBtn}
                    onPress={() => push('/(modals)/propose-trade')}
                >
                    <Text style={styles.proposeBtnText}>+ Propose</Text>
                </Pressable>
            </View>

            <View style={styles.tabRow}>
                {TABS.map((t) => {
                    const active = tab === t.key
                    const badge =
                        t.key === 'offers' && pendingInboxCount > 0
                            ? pendingInboxCount
                            : null
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
                <ActivityIndicator color={colors.primary} style={{ marginTop: spacing['4xl'] }} />
            ) : (
                <FlashList
                    data={listData}
                    keyExtractor={(item, index) => {
                        if (item._type === 'header') return `header-${index}`
                        if (item._type === 'trade') return `trade-${item.trade.id}`
                        return `pick-${item.pick.pickId}`
                    }}
                    getItemType={(item) => item._type}
                    ItemSeparatorComponent={ItemSeparator}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={onRefresh}
                            tintColor={colors.primary}
                        />
                    }
                    renderItem={({ item }) => {
                        if (item._type === 'header') {
                            return item.label ? <SectionHeader label={item.label} /> : null
                        }
                        if (item._type === 'pick') {
                            const isOwn = item.pick.originalTeamName === myTeamName
                            return (
                                <Pressable
                                    style={styles.pickRow}
                                    onPress={() => push('/(modals)/propose-trade')}
                                >
                                    <View style={styles.pickCircle}>
                                        <Text style={styles.pickCircleText}>
                                            {yearShort(item.pick.seasonYear)}
                                        </Text>
                                    </View>
                                    <View style={styles.pickInfo}>
                                        <Text style={styles.pickLabel}>
                                            {item.pick.seasonYear} · Round {item.pick.round}
                                        </Text>
                                        <Text style={styles.pickMeta}>
                                            {isOwn ? 'Own pick' : `from ${item.pick.originalTeamName}`}
                                        </Text>
                                    </View>
                                    <Text style={styles.pickHint}>Trade</Text>
                                </Pressable>
                            )
                        }
                        return (
                            <TradeCard
                                trade={item.trade}
                                myMemberId={myMemberId}
                                leagueId={leagueId}
                                rosterSize={rosterSize}
                                tab={tab}
                                onAction={load}
                            />
                        )
                    }}
                />
            )}
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    headerTitle: { fontSize: 17, fontWeight: fontWeight.bold },
    proposeBtn: {
        backgroundColor: colors.primary,
        paddingHorizontal: spacing.lg,
        paddingVertical: 7,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        minWidth: 90,
        alignItems: 'center',
    },
    proposeBtnText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },

    tabRow: {
        flexDirection: 'row',
        gap: spacing.md,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    tabChip: {
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    tabChipActive: { backgroundColor: colors.primary },
    tabChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    tabChipTextActive: { color: colors.textWhite },

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

    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.4)',
        justifyContent: 'flex-end',
    },
    modalSheet: {
        backgroundColor: colors.bgScreen,
        borderTopLeftRadius: radii['3xl'],
        borderTopRightRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        paddingTop: spacing['2xl'],
        paddingHorizontal: spacing.xl,
        paddingBottom: spacing['4xl'],
        maxHeight: '75%',
    },
    modalTitle: { fontSize: 17, fontWeight: fontWeight.bold, color: colors.textPrimary, marginBottom: spacing.xs },
    modalSubtitle: { fontSize: fontSize.sm, color: colors.textMuted, marginBottom: 14 },
    modalScroll: { flexGrow: 0 },
    dropRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        gap: 10,
    },
    dropPlayerInfo: { flex: 1 },
    dropPlayerName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    dropPlayerMeta: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
    dropBtn: {
        backgroundColor: colors.danger,
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        minWidth: 60,
        alignItems: 'center',
    },
    dropBtnText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.sm },
    modalCancelBtn: {
        marginTop: 14,
        paddingVertical: spacing.sm + 7,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        alignItems: 'center',
    },
    modalCancelText: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.textSecondary },

    pickRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.lg,
    },
    pickCircle: {
        width: 44,
        height: 44,
        borderRadius: 22,
        borderCurve: 'continuous' as const,
        backgroundColor: palette.indigo500,
        justifyContent: 'center',
        alignItems: 'center',
    },
    pickCircleText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.sm },
    pickInfo: { flex: 1, gap: 2 },
    pickLabel: { fontSize: fontSize.md, fontWeight: fontWeight.semibold },
    pickMeta: { fontSize: fontSize.sm, color: colors.textMuted },
    pickHint: { fontSize: 12, color: colors.primary, fontWeight: fontWeight.bold },
})
