import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { useRouter } from 'expo-router'
import { useIsFocused } from '@react-navigation/native'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { NoLeagueState } from '@/components/NoLeagueState'
import { isTradingClosed } from '@/lib/league'
import {
    getPicksForMember,
    type Trade,
    type TradePickItem,
} from '@/lib/trades'
import { colors, fontSize, spacing, textStyles } from '@/constants/tokens'
import { SegmentedControl, type SegmentOption } from '@/components/ui/SegmentedControl'
import { Sheet } from '@/components/ui/Sheet'
import { ItemSeparator } from '@/components/ItemSeparator'
import { Button, ErrorBanner, Page, PageHeader, usePageMetrics } from '@/components/ui'
import { PicksTable } from '@/components/trades/PicksTable'
import { TradeDetailsPanel } from '@/components/trades/TradeDetailsPanel'
import { tradeCardModel } from '@/components/trades/TradeCard'
import type { TradeTabKey } from '@/lib/trade-ui-model'
import {
    TradeBlockListingRow,
    TradeBlockPickRow,
    TradeBlockPlayerRow,
    TradeEmptyRow,
    TradeOfferRow,
    TradeSectionRow,
} from '@/components/trades/TradeListRow'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { useTradesFeed } from '@/hooks/use-trades-feed'
import { useTradeHistoryFeed } from '@/hooks/use-trade-history-feed'
import { useTradeBlock } from '@/hooks/use-trade-block'
import { useTradeActions } from '@/hooks/use-trade-actions'
import { useTradeScreenRealtime } from '@/hooks/use-trade-screen-realtime'
import { useAuth } from '@/hooks/use-auth'
import {
    buildTradeScreenModel,
    tradeListItemType,
    tradeListKey,
    tradeScreenResource,
    type TradeListItem,
} from '@/lib/trades-screen-model'

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

const PICKS_CACHE_PREFIX = 'pancake:trade-picks:v1:'
const picksCacheKey = (userId: string, memberId: string, leagueId: string) => `${PICKS_CACHE_PREFIX}${userId}:${leagueId}:${memberId}`
const TradeAnalyzer = lazy(() => import('@/components/trades/TradeAnalyzer'))

// Offer list width when the open trade sits beside it.
const SPLIT_LIST_WIDTH = 440
const SPLIT_MIN_WIDTH = 960

function blockColumns(usableWidth: number) {
    if (usableWidth >= 1080) return 3
    if (usableWidth >= 700) return 2
    return 1
}

function CardGap() {
    return <View style={styles.cardGap} />
}

export default function TradesScreen() {
    const { push } = useRouter()
    const { user } = useAuth()
    const { current, currentLeague, memberships, loading: leagueLoading, isCommissioner, online } = useLeagueContext()
    const focused = useIsFocused()
    const myMemberId = current?.id ?? ''
    const leagueId = currentLeague?.id ?? ''
    const myTeamName = current?.team_name ?? ''
    const tradingClosed = isTradingClosed(currentLeague)
    const cachedPicks = useMemo(
        () => user?.id && myMemberId && leagueId
            ? readPersistentCache<TradePickItem[]>(picksCacheKey(user.id, myMemberId, leagueId))
            : null,
        [leagueId, myMemberId, user?.id],
    )
    const { padX, usableWidth } = usePageMetrics()
    const [tab, setTab] = useState<TradeTabKey>('offers')
    const [openTradeId, setOpenTradeId] = useState<string | null>(null)
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
        isSnapshot: tradesSnapshot,
        loadMoreError: offersLoadMoreError,
        refresh: load,
        loadMore: loadMoreOffers,
    } = useTradesFeed(myMemberId, leagueId, online)
    const {
        trades: historyTrades,
        loading: historyLoading,
        hasMore: historyHasMore,
        error: historyError,
        refresh: refreshHistoryFeed,
        loadMore: loadMoreHistory,
    } = useTradeHistoryFeed(myMemberId, leagueId, tab === 'history')
    const decisionsDisabled = !online || tradesSnapshot || Boolean(tradesError)
    const tradeActions = useTradeActions({
        memberId: myMemberId,
        leagueId,
        onAction: load,
        enabled: !decisionsDisabled,
    })
    const {
        items: blockItems,
        roster: blockRoster,
        avgMap: blockAvgMap,
        avgStatsMap: blockAvgStatsMap,
        loading: blockLoading,
        error: blockError,
        actionError: blockActionError,
        busyId: blockBusyId,
        refresh: loadBlock,
        addPlayer: handleListPlayer,
        addPick: handleListPick,
        removeItem: handleRemoveBlockItem,
    } = useTradeBlock(myMemberId, leagueId, online)
    const listedPlayerIds = useMemo(() => new Set(blockItems.flatMap((block) =>
        block.memberId === myMemberId && block.asset.kind === 'player' ? [block.asset.playerId] : [],
    )), [blockItems, myMemberId])
    const listedPickIds = useMemo(() => new Set(blockItems.flatMap((block) =>
        block.memberId === myMemberId && block.asset.kind === 'pick' ? [block.asset.pickId] : [],
    )), [blockItems, myMemberId])
    const { data: picks, loading: picksLoading, error: picksError, isSnapshot: picksSnapshot, refresh: refreshPicks } = useFocusAsyncData(async () => {
        if (!current || !leagueId) return [] as TradePickItem[]
        const result = await getPicksForMember(current.id, leagueId)
        if (user?.id) writePersistentCache(picksCacheKey(user.id, current.id, leagueId), result)
        return result
    }, [current?.id, leagueId, user?.id], { initialData: cachedPicks ?? undefined, staleMs: 300_000 })

    useTradeScreenRealtime({
        online,
        focused,
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
        tradesError: Boolean(tab === 'history' ? historyError : tradesError),
        blockLoading,
        blockError: Boolean(blockError),
        blockRoster,
        leagueBlockItems: blockItems,
    }), [blockError, blockItems, blockLoading, blockRoster, historyError, historyLoading, historyTrades, loading, myMemberId, picksList, tab, trades, tradesError])
    const { listData, pendingInboxCount } = screenModel
    const tradeTab = tab === 'offers' || tab === 'history'
    // Wide screens keep the offer list and the open trade side by side.
    const split = tradeTab && usableWidth >= SPLIT_MIN_WIDTH
    const gridColumns = tab === 'block' || tab === 'leagueBlock' ? blockColumns(usableWidth) : 1
    const listTrades = useMemo(
        () => listData.flatMap((item) => (item._type === 'trade' ? [item.trade] : [])),
        [listData],
    )
    const openTrade = (openTradeId ? listTrades.find((trade) => trade.id === openTradeId) : null)
        ?? (split ? listTrades[0] ?? null : null)
    const openTradeDetails = useCallback((trade: Trade) => setOpenTradeId(trade.id), [])
    const renderItem = useCallback(({ item }: { item: TradeListItem }) => {
        switch (item._type) {
            case 'header':
                return <TradeSectionRow item={item} />
            case 'empty':
                return <TradeEmptyRow item={item} />
            case 'pick':
                // The picks tab renders PicksTable instead of list rows.
                return null
            case 'blockItem':
                return <TradeBlockListingRow item={item} myMemberId={myMemberId} tab={tab}
                    blockBusyId={blockBusyId} disabled={!online} tile={gridColumns > 1} onRemove={handleRemoveBlockItem} />
            case 'blockPlayer': {
                const playerId = item.player.players.id
                return <TradeBlockPlayerRow item={item} listed={listedPlayerIds.has(playerId)}
                    busy={!online || blockBusyId === playerId} blockAvgMap={blockAvgMap} tile={gridColumns > 1}
                    blockAvgStatsMap={blockAvgStatsMap} onList={handleListPlayer} />
            }
            case 'blockPick':
                return <TradeBlockPickRow item={item} listed={listedPickIds.has(item.pick.pickId)}
                    busy={!online || blockBusyId === item.pick.pickId} tile={gridColumns > 1} myTeamName={myTeamName}
                    onList={handleListPick} />
            case 'trade':
                return <TradeOfferRow item={item} myMemberId={myMemberId} tab={tab}
                    tradeVetoMode={currentLeague?.trade_veto_mode ?? 'member_vote'}
                    isCommissioner={isCommissioner} acting={tradeActions.busyTradeId !== null} decisionsDisabled={decisionsDisabled}
                    onAccept={tradeActions.accept} onReject={tradeActions.reject}
                    onVeto={tradeActions.veto} onWithdraw={tradeActions.withdraw}
                    onAnalyze={openAnalyzer} selected={split && item.trade.id === openTrade?.id} brief={split}
                    onOpen={openTradeDetails} />
        }
    }, [blockAvgMap, blockAvgStatsMap, blockBusyId, decisionsDisabled, online, currentLeague?.trade_veto_mode, gridColumns, handleListPick, handleListPlayer,
        handleRemoveBlockItem, isCommissioner, listedPickIds, listedPlayerIds, myMemberId, myTeamName,
        openAnalyzer, openTrade?.id, openTradeDetails, split, tab, tradeActions.accept, tradeActions.busyTradeId, tradeActions.reject,
        tradeActions.veto, tradeActions.withdraw])

    const activeTabLoading = tab === 'picks' ? picksLoading && picksList.length === 0
        : tab === 'analyzer' ? false
        : tab === 'block' ? blockLoading && blockItems.length === 0 && blockRoster.length === 0 && picksList.length === 0
            : tab === 'leagueBlock' ? blockLoading && blockItems.length === 0
                : tab === 'history' ? historyLoading && historyTrades.length === 0
                    : loading && trades.length === 0
    // Ordered by how often a manager needs each one: respond to offers, scout
    // the league's block, then the tools and records.
    const tabOptions: SegmentOption<TradeTabKey>[] = [
        { label: 'Offers', value: 'offers', badge: pendingInboxCount > 0 ? pendingInboxCount : undefined },
        { label: 'Trade Block', value: 'leagueBlock', accessibilityLabel: 'League trade block' },
        { label: 'My Block', value: 'block', accessibilityLabel: 'Your trade block' },
        { label: 'Analyzer', value: 'analyzer' },
        { label: 'History', value: 'history' },
        { label: 'Picks', value: 'picks' },
    ]
    const activeResource = tradeScreenResource(tab)
    const activeError = activeResource === 'picks' ? picksError
        : activeResource === 'block' ? blockError
            : activeResource === 'history' ? historyError
                : tradesError
    // A failed add/remove or a failed load-more is reported, but it is not a
    // failed load: the list (and its empty rows) stays as it is.
    const activeActionError = activeResource === 'block' ? blockActionError
        : activeResource === 'trades' ? offersLoadMoreError
            : null
    const resourceLabel = activeResource === 'picks' ? 'draft picks' : activeResource === 'block' ? 'trade block' : activeResource === 'history' ? 'trade history' : 'trades'
    const hasSavedData = activeResource === 'picks' ? picks !== null
        : activeResource === 'block' ? blockItems.length > 0 || blockRoster.length > 0 || picksList.length > 0
            : activeResource === 'history' ? historyTrades.length > 0 : trades.length > 0
    const isSnapshot = !online || Boolean(activeError) || (activeResource === 'picks' ? picksSnapshot
        : activeResource === 'block' ? blockLoading : activeResource === 'history' ? historyLoading : tradesSnapshot)
    const retryActiveResource = activeResource === 'picks' ? refreshPicks
        : activeResource === 'block' ? loadBlock
            : activeResource === 'history' ? refreshHistoryFeed
                : load

    const changeTab = (next: TradeTabKey) => {
        setTab(next)
        setOpenTradeId(null)
    }
    const header = (disabled: boolean, onPropose: () => void) => (
        <PageHeader
            tabs={<TradeTabs options={tabOptions} tab={tab} setTab={changeTab} />}
            actions={(
                <Button
                    // The smallest phones keep the tabs readable with an icon-only button.
                    title={usableWidth < 340 ? undefined : !online ? 'Offline' : disabled ? 'Locked' : 'Propose'}
                    icon={disabled ? 'lock' : 'add'}
                    size="sm"
                    onPress={onPropose}
                    disabled={disabled}
                    accessibilityLabel={!online ? 'Reconnect to propose a trade' : disabled ? 'Trades unavailable' : 'Propose trade'}
                />
            )}
        />
    )

    if (memberships.length === 0 && leagueLoading) {
        // Header and tabs match the loaded chrome exactly; the list area stays
        // blank so content appears fully formed instead of swapping a loading
        // card for lists.
        return <Page title="Trades">{header(true, () => {})}</Page>
    }
    if (memberships.length === 0) return <NoLeagueState />

    const tradeContext = openTrade ? {
        trade: openTrade,
        myMemberId,
        tab,
        tradeVetoMode: currentLeague?.trade_veto_mode ?? 'member_vote',
        isCommissioner,
    } : null
    const detailActions = openTrade ? {
        acting: tradeActions.busyTradeId !== null || decisionsDisabled,
        onAccept: () => tradeActions.accept(openTrade),
        onReject: () => tradeActions.reject(openTrade.id),
        onVeto: () => tradeActions.veto(openTrade.id),
        onWithdraw: () => tradeActions.withdraw(openTrade.id),
    } : null
    const list = (
        <FlashList data={listData} keyExtractor={tradeListKey} getItemType={tradeListItemType}
            key={`${tab}:${gridColumns}`}
            numColumns={gridColumns}
            overrideItemLayout={(itemLayout, item, _index, maxColumns) => {
                if (item._type === 'header' || item._type === 'empty') itemLayout.span = maxColumns
            }}
            ItemSeparatorComponent={tradeTab ? CardGap : gridColumns > 1 ? undefined : ItemSeparator}
            renderItem={renderItem}
            contentContainerStyle={{ paddingHorizontal: padX, paddingBottom: spacing['3xl'] }}
            onEndReached={tab === 'history' && historyHasMore
                ? loadMoreHistory
                : tab === 'offers' && offersHaveMore && !offersLoadingMore ? loadMoreOffers : undefined}
            onEndReachedThreshold={0.4} />
    )

    return <Page title="Trades">
        {header(!online || tradingClosed, () => push('/(modals)/propose-trade'))}
        {activeError ? <ErrorBanner message={hasSavedData
            ? `${resourceLabel[0].toUpperCase() + resourceLabel.slice(1)} refresh failed. Showing a saved snapshot.${online ? ' Tap to retry.' : ' Reconnect to update.'}`
            : `${online ? 'Could not load' : 'Offline. No saved'} ${resourceLabel}.${online ? ' Tap to retry.' : ' Reconnect to load.'}`}
            onRetry={() => { if (online) void retryActiveResource() }} />
            : hasSavedData && isSnapshot ? <Text style={styles.freshness} accessibilityLiveRegion="polite">
                {online ? `Refreshing ${resourceLabel}. Showing a saved snapshot.` : `Offline. Showing a saved ${resourceLabel} snapshot.`}
            </Text> : null}
        {!activeError && activeActionError ? <ErrorBanner message={`${activeActionError.replace(/[.!]?\s*$/, '.')} Tap to refresh.`}
            onRetry={() => { void retryActiveResource() }} /> : null}
        {tab === 'analyzer' ? (
            <Suspense fallback={<View style={styles.emptyState}><Text style={styles.emptyStateText}>Loading Analyzer…</Text></View>}>
                <TradeAnalyzer prefillTrade={analyzerTrade} />
            </Suspense>
        ) : activeTabLoading ? null
            : tab === 'picks' && picksError && picks === null ? null
                : tab === 'picks' && picksList.length === 0 ? <View style={styles.emptyState}><Text style={styles.emptyStateText}>No draft picks</Text></View>
                    : tab === 'picks' ? (
                        <ScrollView contentContainerStyle={[styles.picks, { paddingHorizontal: padX }]}>
                            <PicksTable picks={picksList} myTeamName={myTeamName} />
                        </ScrollView>
                    )
                    : split ? (
                        <View style={styles.split}>
                            <View style={styles.splitList}>{list}</View>
                            <ScrollView style={styles.splitDetail} contentContainerStyle={styles.splitDetailContent}>
                                {tradeContext && detailActions ? (
                                    <TradeDetailsPanel context={tradeContext} actions={detailActions}
                                        onAnalyze={() => openAnalyzer(tradeContext.trade)} />
                                ) : (
                                    <Text style={styles.detailHint}>Select a trade to see every asset and note.</Text>
                                )}
                            </ScrollView>
                        </View>
                    )
                    : list}
        {!split && tradeContext && detailActions ? (
            <Sheet
                visible={openTradeId != null}
                title={tradeCardModel(tradeContext).opponentName}
                onClose={() => setOpenTradeId(null)}
            >
                <TradeDetailsPanel context={tradeContext} actions={detailActions} showHeader={false}
                    onAnalyze={() => { setOpenTradeId(null); openAnalyzer(tradeContext.trade) }} />
            </Sheet>
        ) : null}
    </Page>
}

function TradeTabs({ options, tab, setTab }: { options: SegmentOption<TradeTabKey>[]; tab: TradeTabKey; setTab: (tab: TradeTabKey) => void }) {
    return <SegmentedControl variant="tabs" options={options} value={tab} onChange={setTab}
        idBase="trade-section" scrollable accessibilityLabel="Trade sections" />
}

const styles = StyleSheet.create({
    freshness: { color: colors.textSecondary, fontSize: fontSize.sm, paddingHorizontal: spacing.xl, paddingVertical: spacing.sm },
    cardGap: { height: spacing.md },
    picks: { paddingTop: spacing.lg, paddingBottom: spacing['3xl'] },
    split: { flex: 1, minHeight: 0, flexDirection: 'row' },
    splitList: { width: SPLIT_LIST_WIDTH, flexShrink: 0 },
    splitDetail: { flex: 1, borderLeftWidth: 1, borderLeftColor: colors.borderLight },
    splitDetailContent: { maxWidth: 720, padding: spacing['3xl'] },
    detailHint: { ...textStyles.meta, paddingTop: spacing['4xl'], textAlign: 'center' },
    emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', marginTop: spacing['4xl'] },
    emptyStateText: { ...textStyles.body, color: colors.textPlaceholder },
})
