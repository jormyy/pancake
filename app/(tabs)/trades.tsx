import { Pressable, StyleSheet, Text, View } from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { NoLeagueState } from '@/components/NoLeagueState'
import { EmptyState } from '@/components/EmptyState'
import { isTradingClosed } from '@/lib/league'
import {
    getPicksForMember,
    type TradePickItem,
} from '@/lib/trades'
import { colors, fontSize, fontWeight, layout, radii, spacing } from '@/constants/tokens'
import { SegmentedControl, type SegmentOption } from '@/components/ui/SegmentedControl'
import { ItemSeparator } from '@/components/ItemSeparator'
import { ErrorBanner } from '@/components/ui'
import { type TabKey } from '@/components/trades/TradeCard'
import { TradeListRow } from '@/components/trades/TradeListRow'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import {
    debounceRealtimeRefresh,
    disposeTableChangeSubscription,
    subscribeToTableChanges,
} from '@/lib/realtime'
import { tradeScreenWatches } from '@/lib/trades-realtime'
import { useTradesFeed } from '@/hooks/use-trades-feed'
import { useTradeBlock } from '@/hooks/use-trade-block'
import {
    buildTradeScreenModel,
    tradeListItemType,
    tradeListKey,
    tradeLoadingMessage,
    tradeScreenResource,
    type TradeListItem,
} from '@/lib/trades-screen-model'

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

const PICKS_CACHE_PREFIX = 'pancake:trade-picks:v1:'
const picksCacheKey = (memberId: string, leagueId: string) => `${PICKS_CACHE_PREFIX}${leagueId}:${memberId}`

export default function TradesScreen() {
    const { push } = useRouter()
    const { current, currentLeague, memberships, loading: leagueLoading, isCommissioner } = useLeagueContext()
    const myMemberId = current?.id ?? ''
    const leagueId = currentLeague?.id ?? ''
    const rosterSize = currentLeague?.roster_size ?? 20
    const myTeamName = current?.team_name ?? ''
    const tradingClosed = isTradingClosed(currentLeague)
    const cachedPicks = useMemo(
        () => myMemberId && leagueId ? readPersistentCache<TradePickItem[]>(picksCacheKey(myMemberId, leagueId)) : null,
        [leagueId, myMemberId],
    )
    const [tab, setTab] = useState<TabKey>('picks')
    const {
        trades,
        loading,
        loadingMore: tradesLoadingMore,
        hasMore: tradesHaveMore,
        error: tradesError,
        refresh: load,
        loadMore: loadMoreTrades,
    } = useTradesFeed(myMemberId, leagueId)
    const {
        items: blockItems,
        roster: blockRoster,
        avgMap: blockAvgMap,
        avgStatsMap: blockAvgStatsMap,
        loading: blockLoading,
        error: blockError,
        busyId: blockBusyId,
        refresh: loadBlock,
        addPlayer: handleListPlayer,
        addPick: handleListPick,
        removeItem: handleRemoveBlockItem,
    } = useTradeBlock(myMemberId, leagueId)
    const listedPlayerIds = useMemo(() => new Set(blockItems.flatMap((block) =>
        block.memberId === myMemberId && block.asset.kind === 'player' ? [block.asset.playerId] : [],
    )), [blockItems, myMemberId])
    const listedPickIds = useMemo(() => new Set(blockItems.flatMap((block) =>
        block.memberId === myMemberId && block.asset.kind === 'pick' ? [block.asset.pickId] : [],
    )), [blockItems, myMemberId])
    const { data: picks, loading: picksLoading, error: picksError, refresh: refreshPicks } = useFocusAsyncData(async () => {
        if (!current || !leagueId) return [] as TradePickItem[]
        const result = await getPicksForMember(current.id, leagueId)
        writePersistentCache(picksCacheKey(current.id, leagueId), result)
        return result
    }, [current?.id, leagueId], { initialData: cachedPicks ?? undefined })

    useEffect(() => {
        if (!myMemberId || !leagueId) return
        const refreshTrades = debounceRealtimeRefresh(() => { void load() })
        const refreshTradeBlock = debounceRealtimeRefresh(() => { void loadBlock() })
        const refreshDraftPicks = debounceRealtimeRefresh(() => { void refreshPicks() })
        const channel = subscribeToTableChanges(`trades-screen:${leagueId}:${myMemberId}`, {
            mode: 'per-watch',
            watches: tradeScreenWatches(leagueId, {
                trades: refreshTrades.trigger,
                tradeBlock: refreshTradeBlock.trigger,
                draftPicks: refreshDraftPicks.trigger,
            }),
        })
        return () => disposeTableChangeSubscription(channel, [refreshTrades, refreshTradeBlock, refreshDraftPicks])
    }, [leagueId, load, loadBlock, myMemberId, refreshPicks])

    useEffect(() => {
        if (tab === 'block' || tab === 'leagueBlock') void loadBlock()
    }, [loadBlock, tab])

    const picksList = useMemo(() => picks ?? [], [picks])
    const screenModel = useMemo(() => buildTradeScreenModel({
        tab,
        trades,
        blockItems,
        memberId: myMemberId,
        picks: picksList,
        tradesLoading: loading,
        blockLoading,
        blockRoster,
        leagueBlockItems: blockItems,
    }), [blockItems, blockLoading, blockRoster, loading, myMemberId, picksList, tab, trades])
    const { historyTrades, listData, pendingInboxCount } = screenModel
    const renderItem = useCallback(({ item }: { item: TradeListItem }) => (
        <TradeListRow item={item} myTeamName={myTeamName} myMemberId={myMemberId} leagueId={leagueId}
            rosterSize={rosterSize} tab={tab} tradeVetoMode={currentLeague?.trade_veto_mode ?? 'member_vote'}
            isCommissioner={isCommissioner} listedPlayerIds={listedPlayerIds} listedPickIds={listedPickIds}
            blockBusyId={blockBusyId} blockAvgMap={blockAvgMap} blockAvgStatsMap={blockAvgStatsMap}
            onListPlayer={handleListPlayer} onListPick={handleListPick} onRemoveBlockItem={handleRemoveBlockItem}
            onTradeAction={load} />
    ), [blockAvgMap, blockAvgStatsMap, blockBusyId, currentLeague?.trade_veto_mode, handleListPick, handleListPlayer,
        handleRemoveBlockItem, isCommissioner, leagueId, listedPickIds, listedPlayerIds, load, myMemberId,
        myTeamName, rosterSize, tab])

    const activeTabLoading = tab === 'picks' ? picksLoading && picksList.length === 0
        : tab === 'block' ? blockLoading && blockItems.length === 0 && blockRoster.length === 0 && picksList.length === 0
            : tab === 'leagueBlock' ? blockLoading && blockItems.length === 0
                : loading && trades.length === 0
    const tabOptions: SegmentOption<TabKey>[] = [
        { label: 'Picks', value: 'picks' },
        { label: 'Offers', value: 'offers', badge: pendingInboxCount > 0 ? pendingInboxCount : undefined },
        { label: 'Your Block', value: 'block' },
        { label: 'League Block', value: 'leagueBlock' },
        { label: 'History', value: 'history' },
    ]
    const activeResource = tradeScreenResource(tab)
    const activeError = activeResource === 'picks' ? picksError : activeResource === 'block' ? blockError : tradesError
    const retryActiveResource = activeResource === 'picks' ? refreshPicks : activeResource === 'block' ? loadBlock : load

    useEffect(() => {
        if (tab === 'history' && historyTrades.length === 0 && tradesHaveMore && !tradesLoadingMore) {
            void loadMoreTrades()
        }
    }, [historyTrades.length, loadMoreTrades, tab, tradesHaveMore, tradesLoadingMore])

    if (memberships.length === 0 && leagueLoading) {
        return <SafeAreaView style={styles.container}><View style={styles.content}>
            <TradeHeader disabled onPropose={() => {}} />
            <TradeTabs options={tabOptions} tab={tab} setTab={setTab} />
            <EmptyState fullScreen={false} message="Loading trades"
                description="Your trade inbox appears here as soon as league context is ready." />
        </View></SafeAreaView>
    }
    if (memberships.length === 0) return <NoLeagueState />
    return <SafeAreaView style={styles.container}><View style={styles.content}>
        <TradeHeader disabled={tradingClosed} onPropose={() => push('/(modals)/propose-trade')} />
        <TradeTabs options={tabOptions} tab={tab} setTab={setTab} />
        {activeError ? <ErrorBanner message={`Failed to load ${activeResource === 'picks' ? 'draft picks' : activeResource === 'block' ? 'trade block' : 'trades'}. Tap to retry.`}
            onRetry={() => { void retryActiveResource() }} /> : null}
        {activeTabLoading ? <EmptyState fullScreen={false} message={tradeLoadingMessage(tab)}
            description="Cached trade content stays visible while fresh data updates in place." />
            : tab === 'picks' && picksError ? <View style={styles.emptyState}><Text style={styles.emptyStateText}>Error: {picksError.message}</Text></View>
                : tab === 'picks' && picksList.length === 0 ? <View style={styles.emptyState}><Text style={styles.emptyStateText}>No draft picks</Text></View>
                    : <FlashList data={listData} keyExtractor={tradeListKey} getItemType={tradeListItemType}
                        ItemSeparatorComponent={ItemSeparator} renderItem={renderItem}
                        onEndReached={tab === 'history' && tradesHaveMore ? loadMoreTrades : undefined}
                        onEndReachedThreshold={0.4} />}
    </View></SafeAreaView>
}

function TradeHeader({ disabled, onPropose }: { disabled: boolean; onPropose: () => void }) {
    return <View style={styles.header}>
        <Text style={styles.headerTitle} role="heading" aria-level={1}>Trades</Text>
        <Pressable style={[styles.proposeBtn, disabled && styles.proposeBtnDisabled]} onPress={onPropose}
            disabled={disabled} accessibilityRole="button" accessibilityLabel={disabled ? 'Trades unavailable' : 'Propose trade'}
            accessibilityState={{ disabled }}>
            <Text style={[styles.proposeBtnText, disabled && styles.proposeBtnTextDisabled]}>{disabled ? 'Locked' : '+ Propose'}</Text>
        </Pressable>
    </View>
}

function TradeTabs({ options, tab, setTab }: { options: SegmentOption<TabKey>[]; tab: TabKey; setTab: (tab: TabKey) => void }) {
    return <View style={styles.tabRow}><SegmentedControl options={options} value={tab} onChange={setTab}
        accessibilityLabel="Trade sections" scrollable /></View>
}

const styles = StyleSheet.create({
    content: { flex: 1, width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center' },
    container: { flex: 1, backgroundColor: colors.bgScreen },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
    headerTitle: { fontSize: 17, fontWeight: fontWeight.bold, color: colors.textPrimary },
    proposeBtn: { backgroundColor: colors.primary, paddingHorizontal: spacing.lg, paddingVertical: 7, borderRadius: radii.md, borderCurve: 'continuous', minWidth: 90, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    proposeBtnText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },
    proposeBtnDisabled: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: colors.borderLight },
    proposeBtnTextDisabled: { color: colors.textPlaceholder },
    tabRow: { paddingHorizontal: spacing.xl, paddingVertical: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
    emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', marginTop: spacing['4xl'] },
    emptyStateText: { fontSize: fontSize.md, color: colors.textPlaceholder },
})
