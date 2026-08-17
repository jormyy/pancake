import { Pressable, StyleSheet, Text, View } from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { NoLeagueState } from '@/components/NoLeagueState'
import { isTradingClosed } from '@/lib/league'
import {
    getPicksForMember,
    type Trade,
    type TradePickItem,
} from '@/lib/trades'
import { colors, fontSize, fontWeight, layout, radii, spacing } from '@/constants/tokens'
import { SegmentedControl, type SegmentOption } from '@/components/ui/SegmentedControl'
import { ItemSeparator } from '@/components/ItemSeparator'
import { ErrorBanner } from '@/components/ui'
import type { TradeTabKey } from '@/lib/trade-ui-model'
import {
    TradeBlockListingRow,
    TradeBlockPickRow,
    TradeBlockPlayerRow,
    TradeEmptyRow,
    TradeOfferRow,
    TradePickRow,
    TradeSectionRow,
} from '@/components/trades/TradeListRow'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { useTradesFeed } from '@/hooks/use-trades-feed'
import { useTradeHistoryFeed } from '@/hooks/use-trade-history-feed'
import { useTradeBlock } from '@/hooks/use-trade-block'
import { useTradeActions } from '@/hooks/use-trade-actions'
import { useTradeScreenRealtime } from '@/hooks/use-trade-screen-realtime'
import {
    buildTradeScreenModel,
    tradeListItemType,
    tradeListKey,
    tradeScreenResource,
    type TradeListItem,
} from '@/lib/trades-screen-model'

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

const PICKS_CACHE_PREFIX = 'pancake:trade-picks:v1:'
const picksCacheKey = (memberId: string, leagueId: string) => `${PICKS_CACHE_PREFIX}${leagueId}:${memberId}`
const TradeAnalyzer = lazy(() => import('@/components/trades/TradeAnalyzer'))

export default function TradesScreen() {
    const { push } = useRouter()
    const { current, currentLeague, memberships, loading: leagueLoading, isCommissioner } = useLeagueContext()
    const myMemberId = current?.id ?? ''
    const leagueId = currentLeague?.id ?? ''
    const myTeamName = current?.team_name ?? ''
    const tradingClosed = isTradingClosed(currentLeague)
    const cachedPicks = useMemo(
        () => myMemberId && leagueId ? readPersistentCache<TradePickItem[]>(picksCacheKey(myMemberId, leagueId)) : null,
        [leagueId, myMemberId],
    )
    const [tab, setTab] = useState<TradeTabKey>('picks')
    const [analyzerTrade, setAnalyzerTrade] = useState<Trade | null>(null)
    const openAnalyzer = useCallback((trade: Trade) => {
        setAnalyzerTrade(trade)
        setTab('analyzer')
    }, [])
    const {
        trades,
        loading,
        loadingMore: offersLoadingMore,
        hasMore: offersHaveMore,
        error: tradesError,
        refresh: load,
        loadMore: loadMoreOffers,
    } = useTradesFeed(myMemberId, leagueId)
    const {
        trades: historyTrades,
        loading: historyLoading,
        hasMore: historyHasMore,
        error: historyError,
        refresh: refreshHistoryFeed,
        loadMore: loadMoreHistory,
    } = useTradeHistoryFeed(myMemberId, leagueId, tab === 'history')
    const tradeActions = useTradeActions({
        memberId: myMemberId,
        leagueId,
        onAction: load,
    })
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
    }, [current?.id, leagueId], { initialData: cachedPicks ?? undefined, staleMs: 300_000 })

    useTradeScreenRealtime({
        leagueId,
        memberId: myMemberId,
        activeTab: tab,
        refreshTrades: load,
        refreshHistory: refreshHistoryFeed,
        refreshTradeBlock: loadBlock,
        refreshDraftPicks: refreshPicks,
    })

    useEffect(() => {
        if (tab === 'block' || tab === 'leagueBlock') void loadBlock()
    }, [loadBlock, tab])

    const picksList = useMemo(() => picks ?? [], [picks])
    const screenModel = useMemo(() => buildTradeScreenModel({
        tab,
        trades,
        historyTrades,
        blockItems,
        memberId: myMemberId,
        picks: picksList,
        tradesLoading: tab === 'history' ? historyLoading : loading,
        blockLoading,
        blockRoster,
        leagueBlockItems: blockItems,
    }), [blockItems, blockLoading, blockRoster, historyLoading, historyTrades, loading, myMemberId, picksList, tab, trades])
    const { listData, pendingInboxCount } = screenModel
    const renderItem = useCallback(({ item }: { item: TradeListItem }) => {
        switch (item._type) {
            case 'header':
                return <TradeSectionRow item={item} />
            case 'empty':
                return <TradeEmptyRow item={item} />
            case 'pick':
                return <TradePickRow item={item} myTeamName={myTeamName} />
            case 'blockItem':
                return <TradeBlockListingRow item={item} myMemberId={myMemberId} tab={tab}
                    blockBusyId={blockBusyId} onRemove={handleRemoveBlockItem} />
            case 'blockPlayer': {
                const playerId = item.player.players.id
                return <TradeBlockPlayerRow item={item} listed={listedPlayerIds.has(playerId)}
                    busy={blockBusyId === playerId} blockAvgMap={blockAvgMap}
                    blockAvgStatsMap={blockAvgStatsMap} onList={handleListPlayer} />
            }
            case 'blockPick':
                return <TradeBlockPickRow item={item} listed={listedPickIds.has(item.pick.pickId)}
                    busy={blockBusyId === item.pick.pickId} onList={handleListPick} />
            case 'trade':
                return <TradeOfferRow item={item} myMemberId={myMemberId} tab={tab}
                    tradeVetoMode={currentLeague?.trade_veto_mode ?? 'member_vote'}
                    isCommissioner={isCommissioner} acting={tradeActions.busyTradeId !== null}
                    onAccept={tradeActions.accept} onReject={tradeActions.reject}
                    onVeto={tradeActions.veto} onWithdraw={tradeActions.withdraw}
                    onAnalyze={openAnalyzer} />
        }
    }, [blockAvgMap, blockAvgStatsMap, blockBusyId, currentLeague?.trade_veto_mode, handleListPick, handleListPlayer,
        handleRemoveBlockItem, isCommissioner, listedPickIds, listedPlayerIds, myMemberId,
        myTeamName, openAnalyzer, tab, tradeActions.accept, tradeActions.busyTradeId, tradeActions.reject,
        tradeActions.veto, tradeActions.withdraw])

    const activeTabLoading = tab === 'picks' ? picksLoading && picksList.length === 0
        : tab === 'analyzer' ? false
        : tab === 'block' ? blockLoading && blockItems.length === 0 && blockRoster.length === 0 && picksList.length === 0
            : tab === 'leagueBlock' ? blockLoading && blockItems.length === 0
                : tab === 'history' ? historyLoading && historyTrades.length === 0
                    : loading && trades.length === 0
    const tabOptions: SegmentOption<TradeTabKey>[] = [
        { label: 'Picks', value: 'picks' },
        { label: 'Offers', value: 'offers', badge: pendingInboxCount > 0 ? pendingInboxCount : undefined },
        { label: 'Analyzer', value: 'analyzer' },
        { label: 'My Block', value: 'block', accessibilityLabel: 'Your trade block' },
        { label: 'League', value: 'leagueBlock', accessibilityLabel: 'League trade block' },
        { label: 'History', value: 'history' },
    ]
    const activeResource = tradeScreenResource(tab)
    const activeError = activeResource === 'picks' ? picksError
        : activeResource === 'block' ? blockError
            : activeResource === 'history' ? historyError
                : tradesError
    const retryActiveResource = activeResource === 'picks' ? refreshPicks
        : activeResource === 'block' ? loadBlock
            : activeResource === 'history' ? refreshHistoryFeed
                : load

    if (memberships.length === 0 && leagueLoading) {
        // Header and tabs match the loaded chrome exactly; the list area stays
        // blank so content appears fully formed instead of swapping a loading
        // card for lists.
        return <SafeAreaView style={styles.container}><View style={styles.content}>
            <TradeHeader disabled onPropose={() => {}} />
            <TradeTabs options={tabOptions} tab={tab} setTab={setTab} />
        </View></SafeAreaView>
    }
    if (memberships.length === 0) return <NoLeagueState />
    return <SafeAreaView style={styles.container}><View style={styles.content}>
        <TradeHeader disabled={tradingClosed} onPropose={() => push('/(modals)/propose-trade')} />
        <TradeTabs options={tabOptions} tab={tab} setTab={setTab} />
        {activeError ? <ErrorBanner message={`Failed to load ${activeResource === 'picks' ? 'draft picks' : activeResource === 'block' ? 'trade block' : activeResource === 'history' ? 'trade history' : 'trades'}. Tap to retry.`}
            onRetry={() => { void retryActiveResource() }} /> : null}
        {tab === 'analyzer' ? (
            <Suspense fallback={<View style={styles.emptyState}><Text style={styles.emptyStateText}>Loading Analyzer…</Text></View>}>
                <TradeAnalyzer prefillTrade={analyzerTrade} />
            </Suspense>
        ) : activeTabLoading ? null
            : tab === 'picks' && picksError ? null
                : tab === 'picks' && picksList.length === 0 ? <View style={styles.emptyState}><Text style={styles.emptyStateText}>No draft picks</Text></View>
                    : <FlashList data={listData} keyExtractor={tradeListKey} getItemType={tradeListItemType}
                        ItemSeparatorComponent={ItemSeparator} renderItem={renderItem}
                        onEndReached={tab === 'history' && historyHasMore
                            ? loadMoreHistory
                            : tab === 'offers' && offersHaveMore && !offersLoadingMore ? loadMoreOffers : undefined}
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

function TradeTabs({ options, tab, setTab }: { options: SegmentOption<TradeTabKey>[]; tab: TradeTabKey; setTab: (tab: TradeTabKey) => void }) {
    return <View style={styles.tabRow}><SegmentedControl options={options} value={tab} onChange={setTab}
        scrollable accessibilityLabel="Trade sections" /></View>
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
