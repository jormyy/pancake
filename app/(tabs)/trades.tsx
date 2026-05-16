import {
    View,
    Text,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    RefreshControl,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import {
    getMyTrades,
    getVetoableTrades,
    Trade,
    TradePickItem,
    getPicksForMember,
} from '@/lib/trades'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { ItemSeparator } from '@/components/ItemSeparator'
import { SectionHeader } from '@/components/SectionHeader'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { yearShort } from '@/lib/format'
import { TradeCard, TabKey } from '@/components/trades/TradeCard'

type ListItem =
    | { _type: 'trade'; trade: Trade }
    | { _type: 'header'; label: string }
    | { _type: 'pick'; pick: TradePickItem }

// Module-level: these are pure functions of the row, no closures needed.
const listKeyExtractor = (item: ListItem, index: number) => {
    if (item._type === 'header') return `header-${index}`
    if (item._type === 'trade') return `trade-${item.trade.id}`
    return `pick-${item.pick.pickId}`
}

const listGetItemType = (item: ListItem) => item._type

export default function TradesScreen() {
    const { push } = useRouter()
    const { current, currentLeague } = useLeagueContext()

    const myMemberId = current?.id ?? ''
    const leagueId = currentLeague?.id ?? ''
    const rosterSize: number = currentLeague?.roster_size ?? 20
    const myTeamName = current?.team_name ?? ''

    const [tab, setTab] = useState<TabKey>('picks')
    const [trades, setTrades] = useState<Trade[]>([])
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)

    const { data: picks, loading: picksLoading, error: picksError, refresh: loadDraft } = useFocusAsyncData(async () => {
        if (!current || !leagueId) return [] as TradePickItem[]
        return getPicksForMember(current.id, leagueId)
    }, [current, leagueId])

    const load = useCallback(async () => {
        if (!myMemberId || !leagueId) return
        try {
            const [myTradeData, vetoableTradeData] = await Promise.all([
                getMyTrades(myMemberId, leagueId),
                getVetoableTrades(myMemberId, leagueId),
            ])
            setTrades([...vetoableTradeData, ...myTradeData])
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

    const incomingTrades = useMemo(() => trades.filter(
        (t) => t.recipientMemberId === myMemberId && t.status === 'pending',
    ), [trades, myMemberId])
    const outgoingTrades = useMemo(() => trades.filter(
        (t) => t.proposerMemberId === myMemberId && t.status === 'pending',
    ), [trades, myMemberId])
    const vetoableTrades = useMemo(() => trades.filter(
        (t) => t.status === 'accepted' && t.proposerMemberId !== myMemberId && t.recipientMemberId !== myMemberId,
    ), [trades, myMemberId])
    const historyTrades = useMemo(() => trades.filter(
        (t) => t.status !== 'pending' && (t.proposerMemberId === myMemberId || t.recipientMemberId === myMemberId),
    ), [trades, myMemberId])

    const picksList = useMemo(() => picks ?? [], [picks])

    const renderItem = useCallback(({ item }: { item: ListItem }) => {
        if (item._type === 'header') {
            return item.label ? <SectionHeader label={item.label} /> : null
        }
        if (item._type === 'pick') {
            const isOwn = item.pick.originalTeamName === myTeamName
            return (
                <View style={styles.pickRow}>
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
                </View>
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
    }, [myTeamName, myMemberId, leagueId, rosterSize, tab, load])

    const listData = useMemo<ListItem[]>(() => {
        const result: ListItem[] = []

        if (tab === 'picks') {
            picksList.forEach((p) => result.push({ _type: 'pick', pick: p }))
        } else if (tab === 'offers') {
            result.push({ _type: 'header', label: 'Veto Window' })
            vetoableTrades.forEach((t) => result.push({ _type: 'trade', trade: t }))
            if (vetoableTrades.length === 0 && !loading) {
                result.push({ _type: 'header', label: '' })
            }
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
    }, [tab, vetoableTrades, incomingTrades, outgoingTrades, historyTrades, picksList, loading])

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
                    accessibilityRole="button"
                    accessibilityLabel="Propose trade"
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
                            accessibilityRole="button"
                            accessibilityLabel={`Show ${t.label} trades`}
                            accessibilityState={{ selected: active }}
                        >
                            <Text style={[styles.tabChipText, active && styles.tabChipTextActive]}>
                                {t.label}
                                {badge ? ` (${badge})` : ''}
                            </Text>
                        </Pressable>
                    )
                })}
            </View>

            {tab === 'picks' && picksLoading ? (
                <ActivityIndicator color={colors.primary} style={{ marginTop: spacing['4xl'] }} />
            ) : tab === 'picks' && picksError ? (
                <View style={styles.emptyState}>
                    <Text style={styles.emptyStateText}>Error: {picksError.message}</Text>
                </View>
            ) : tab === 'picks' && picksList.length === 0 && !picksLoading ? (
                <View style={styles.emptyState}>
                    <Text style={styles.emptyStateText}>No draft picks</Text>
                </View>
            ) : loading ? (
                <ActivityIndicator color={colors.primary} style={{ marginTop: spacing['4xl'] }} />
            ) : (
                <FlashList
                    data={listData}
                    keyExtractor={listKeyExtractor}
                    getItemType={listGetItemType}
                    ItemSeparatorComponent={ItemSeparator}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={onRefresh}
                            tintColor={colors.primary}
                        />
                    }
                    renderItem={renderItem}
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

    emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', marginTop: spacing['4xl'] },
    emptyStateText: { fontSize: fontSize.md, color: colors.textPlaceholder },
})
