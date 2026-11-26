import { readScreenSection, saveScreenSection } from '@/lib/screen-section'
import { useRosterLegality } from '@/hooks/use-roster-legality'
import { IRResolutionModal } from '@/components/IRResolutionModal'
import { ScreenStatusScrollView as ScrollView, ScreenStatusOverlay, ScreenStatusProvider, useScreenStatusScroll } from '@/components/ui/ScreenStatusOverlay'
import { DeferredContent } from '@/components/ui/DeferredContent'
import { StyleSheet, Text, View } from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useIsFocused } from '@react-navigation/native'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { NoLeagueState } from '@/components/NoLeagueState'
import { isTradingClosed } from '@/lib/league'
import { type Trade } from '@/lib/trades'
import { colors, layout, spacing, typeScale } from '@/constants/tokens'
import { SegmentedControl, type SegmentOption } from '@/components/ui/SegmentedControl'
import { ErrorBanner, Page, PageHeader, usePageMetrics } from '@/components/ui'
import { TradeDetailsPanel } from '@/components/trades/TradeDetailsPanel'
import { tradeCardModel } from '@/components/trades/TradeCard'
import { TradeNeedsCard } from '@/components/trades/TradeNeedsCard'
import { normalizeTradeTab, TRADE_TABS, type TradeTabKey } from '@/lib/trade-ui-model'
import {
    TradeBlockListingRow,
    TradeBlockPickRow,
    TradeBlockPlayerRow,
    TradeEmptyRow,
    TradeCardFrame,
    TradeOfferRow,
    TradeSectionRow,
} from '@/components/trades/TradeListRow'



import { useTradesFeed } from '@/hooks/use-trades-feed'
import { useTradeHistoryFeed } from '@/hooks/use-trade-history-feed'
import { usePendingTradeCount } from '@/hooks/use-pending-trade-count'
import { useTradeBlock } from '@/hooks/use-trade-block'
import { useTradeActions } from '@/hooks/use-trade-actions'
import { useRosterHoldReady } from '@/hooks/use-roster-hold-ready'
import { rosterLimits } from '@/lib/roster-capacity'

import { useAuth } from '@/hooks/use-auth'
import {
    buildTradeScreenModel,
    tradeCardEdges,
    tradeListItemType,
    tradeListKey,
    tradeScreenResource,
    type TradeListItem,
} from '@/lib/trades-screen-model'

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'


const TradeAnalyzer = lazy(() => import('@/components/trades/TradeAnalyzer'))
const STATIC_TRADE_LIMIT = 10

function blockColumns(usableWidth: number) {
    if (usableWidth >= 1080) return 3
    if (usableWidth >= 700) return 2
    return 1
}

function CardGap() {
    return <View style={styles.cardGap} />
}

function TradesScreen() {
    const statusScroll = useScreenStatusScroll()
    const { push, setParams } = useRouter()
    const params = useLocalSearchParams<{ tab?: string | string[]; tradeId?: string | string[] }>()
    const { user } = useAuth()
    const { current, currentLeague, memberships, loading: leagueLoading, isCommissioner, online } = useLeagueContext()
    const focused = useIsFocused()
    const myMemberId = current?.id ?? ''
    const leagueId = currentLeague?.id ?? ''
    const myTeamName = current?.team_name ?? ''
    const tradingClosed = isTradingClosed(currentLeague)
    const { padX, usableWidth } = usePageMetrics()
    const tab = normalizeTradeTab(params.tab ?? readScreenSection(user?.id, myMemberId, 'trades'))
    const openTradeId = Array.isArray(params.tradeId) ? params.tradeId[0] : params.tradeId
    const setOpenTradeId = useCallback((tradeId: string | null) => setParams({ tradeId: tradeId ?? undefined }), [setParams])
    const [analyzerTrade, setAnalyzerTrade] = useState<{
        trade: Trade
        userId: string | undefined
        memberId: string
        leagueId: string
    } | null>(null)
    const openAnalyzer = useCallback((trade: Trade) => {
        setAnalyzerTrade({ trade, userId: user?.id, memberId: myMemberId, leagueId })
    }, [leagueId, myMemberId, user?.id])
    useEffect(() => { setAnalyzerTrade(null) }, [leagueId, myMemberId, user?.id])
    useEffect(() => {
        const next = normalizeTradeTab(params.tab ?? readScreenSection(user?.id, myMemberId, 'trades'))
        saveScreenSection(user?.id, myMemberId, 'trades', next)
        setAnalyzerTrade(null)
        if (params.tab && params.tab !== next) setParams({ tab: next })
    }, [params.tab, setParams, user?.id, myMemberId])
    const ownedAnalyzerTrade = analyzerTrade?.userId === user?.id &&
        analyzerTrade?.memberId === myMemberId && analyzerTrade?.leagueId === leagueId
        ? analyzerTrade.trade : null
    const {
        trades,
        hasData: offersHaveData,
        loading,
        loadingMore: offersLoadingMore,
        hasMore: offersHaveMore,
        error: tradesError,
        isSnapshot: tradesSnapshot,
        loadMoreError: offersLoadMoreError,
        refresh: load,
        loadMore: loadMoreOffers,
        updateRosterPlan,
    } = useTradesFeed(myMemberId, leagueId, online && tab === 'offers' && focused, { autoLoad: true, accountId: user?.id ?? null })
    const {
        trades: historyTrades,
        hasData: historyHasData,
        loading: historyLoading,
        hasMore: historyHasMore,
        error: historyError,
        refresh: refreshHistoryFeed,
        loadMore: loadMoreHistory,
    } = useTradeHistoryFeed(myMemberId, leagueId, tab === 'history', user?.id ?? null)
    const decisionsDisabled = online && (tradesSnapshot || Boolean(tradesError))
    const limits = useMemo(() => rosterLimits(currentLeague), [currentLeague])
    const rosterLegality = useRosterLegality({ memberId: myMemberId, leagueId, limits, onChanged: load })
    const tradeActions = useTradeActions({
        onRosterError: rosterLegality.report,
        memberId: myMemberId,
        leagueId,
        onAction: load,
        onRosterPlanSaved: updateRosterPlan,
        enabled: !decisionsDisabled,
        tradeVetoMode: currentLeague?.trade_veto_mode,
        tradeVetoWindowHours: currentLeague?.trade_veto_window_hours,
    })
    const holdReady = useRosterHoldReady(myMemberId)
    const {
        items: blockItems,
        hasData: blockHasData,
        displayReady: blockDisplayReady,
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
        setNote: handleSaveBlockNote,
        picks: blockPicks,
    } = useTradeBlock(myMemberId, leagueId, true, { visible: focused && tab === 'block', allowInactive: currentLeague?.allow_inactive_trades ?? false, accountId: user?.id ?? null })
    const listedPlayerIds = useMemo(() => new Set(blockItems.flatMap((block) =>
        block.memberId === myMemberId && block.asset.kind === 'player' ? [block.asset.playerId] : [],
    )), [blockItems, myMemberId])
    const listedPickIds = useMemo(() => new Set(blockItems.flatMap((block) =>
        block.memberId === myMemberId && block.asset.kind === 'pick' ? [block.asset.pickId] : [],
    )), [blockItems, myMemberId])
    const picks = blockPicks
    const picksLoading = blockLoading
    const picksError = blockError
    const refreshPicks = loadBlock

    const picksList = useMemo(() => picks ?? [], [picks])
    const screenModel = useMemo(() => buildTradeScreenModel({
        tab,
        trades,
        historyTrades,
        blockItems,
        memberId: myMemberId,
        picks: picksList,
        tradesSettled: tab === 'history' ? historyHasData : offersHaveData,
        tradesLoading: tab === 'history' ? historyLoading : loading,
        tradesError: Boolean(tab === 'history' ? historyError : tradesError),
        blockLoading,
        blockSettled: blockHasData,
        blockError: Boolean(blockError),
        blockRoster,
        leagueBlockItems: blockItems,
    }), [offersHaveData, historyHasData, blockHasData, blockError, blockItems, blockLoading, blockRoster, historyError, historyLoading, historyTrades, loading, myMemberId, picksList, tab, trades, tradesError])
    const { listData, incomingTrades, vetoableTrades, outgoingTrades } = screenModel
    const pendingInboxCount = usePendingTradeCount()
    const tradeTab = tab === 'offers' || tab === 'history'
    const gridColumns = tab === 'block' ? blockColumns(usableWidth) : 1
    const listTrades = useMemo(
        () => listData.flatMap((item) => (item._type === 'trade' ? [item.trade] : [])),
        [listData],
    )
    const staticTradeList = tradeTab && listTrades.length <= STATIC_TRADE_LIMIT && !(tab === 'offers' ? offersHaveMore : historyHasMore)
    const openTrade = openTradeId ? listTrades.find((trade) => trade.id === openTradeId) ?? null : null
    const openTradeDetails = useCallback((trade: Trade) => setOpenTradeId(trade.id), [setOpenTradeId])
    const cardEdges = useMemo(() => tradeCardEdges(listData), [listData])
    const renderRow = useCallback((item: TradeListItem) => {
        switch (item._type) {
            case 'header':
                return <TradeSectionRow item={item} standalone={gridColumns > 1} />
            case 'empty':
                return <TradeEmptyRow item={item} />
            case 'blockItem':
                return <TradeBlockListingRow item={item} myMemberId={myMemberId}
                    blockBusyId={blockBusyId} disabled={false} tile={gridColumns > 1} onRemove={handleRemoveBlockItem} onSaveNote={handleSaveBlockNote} />
            case 'blockPlayer': {
                const playerId = item.player.players.id
                return <TradeBlockPlayerRow item={item} listed={listedPlayerIds.has(playerId)}
                    busy={blockBusyId === playerId} blockAvgMap={blockAvgMap} tile={gridColumns > 1}
                    blockAvgStatsMap={blockAvgStatsMap} onList={handleListPlayer} />
            }
            case 'blockPick':
                return <TradeBlockPickRow item={item} listed={listedPickIds.has(item.pick.pickId)}
                    busy={blockBusyId === item.pick.pickId} tile={gridColumns > 1} myTeamName={myTeamName}
                    onList={handleListPick} />
            case 'trade':
                return <TradeOfferRow item={item} myMemberId={myMemberId} tab={tab}
                    tradeVetoMode={currentLeague?.trade_veto_mode ?? 'member_vote'}
                    isCommissioner={isCommissioner} acting={tradeActions.busyTradeId !== null} decisionsDisabled={decisionsDisabled}
                    onAccept={openTradeDetails} onReject={tradeActions.reject}
                    onVeto={tradeActions.veto} onWithdraw={tradeActions.withdraw}
                    onWithdrawAcceptance={tradeActions.retractAcceptance}
                    holdReady={holdReady}
                    onAnalyze={openAnalyzer}
                    embedded={gridColumns === 1}
                    onOpen={openTradeDetails} />
        }
    }, [blockAvgMap, blockAvgStatsMap, blockBusyId, decisionsDisabled, currentLeague?.trade_veto_mode, gridColumns, handleListPick, handleListPlayer,
        handleRemoveBlockItem, handleSaveBlockNote, isCommissioner, listedPickIds, listedPlayerIds, myMemberId, myTeamName,
        openAnalyzer, openTradeDetails, tab, tradeActions.busyTradeId, tradeActions.reject,
        holdReady, tradeActions.retractAcceptance, tradeActions.veto, tradeActions.withdraw])
    const renderItem = useCallback(({ item, index }: { item: TradeListItem; index: number }) => {
        const row = renderRow(item)
        if (gridColumns > 1) return row
        return <TradeCardFrame first={cardEdges.first[index] ?? false} last={cardEdges.last[index] ?? false}>{row}</TradeCardFrame>
    }, [cardEdges, gridColumns, renderRow])

    const activeTabLoading = tab === 'block' ? !blockDisplayReady || (picksLoading && picks === null)
        : tab === 'history' ? historyLoading && !historyHasData
            : loading && !offersHaveData
    const tabOptions: SegmentOption<TradeTabKey>[] = TRADE_TABS.map(option =>
        option.value === 'offers' && pendingInboxCount > 0 ? { ...option, badge: pendingInboxCount } : option)
    const activeResource = tradeScreenResource(tab)
    const activeError = activeResource === 'block' ? blockError || picksError
            : activeResource === 'history' ? historyError
                : tradesError
    useLayoutEffect(() => {
        const listReady = tab === 'history' ? historyHasData : tab === 'offers' && offersHaveData
        if (listReady && openTradeId && !activeTabLoading && !activeError && !openTrade) setOpenTradeId(null)
    }, [activeError, activeTabLoading, historyHasData, offersHaveData, openTrade, openTradeId, setOpenTradeId, tab])
    const activeActionError = activeResource === 'block' ? blockActionError
        : activeResource === 'trades' ? offersLoadMoreError
            : null
    const resourceLabel = activeResource === 'block' ? 'trade block' : activeResource === 'history' ? 'trade history' : 'trades'
    const hasSavedData = activeResource === 'block' ? blockItems.length > 0 || blockRoster.length > 0 || picksList.length > 0
            : activeResource === 'history' ? historyTrades.length > 0 : trades.length > 0
    const isSnapshot = !online || Boolean(activeError) || (activeResource === 'block' ? blockLoading : activeResource === 'history' ? historyLoading : tradesSnapshot)
    const retryActiveResource = activeResource === 'block' ? () => Promise.all([loadBlock(), refreshPicks()])
            : activeResource === 'history' ? refreshHistoryFeed
                : load

    const changeTab = (next: TradeTabKey) => {
        saveScreenSection(user?.id, myMemberId, 'trades', next)
        setAnalyzerTrade(null)
        setParams({ tab: next, tradeId: undefined })
    }
    const proposeTrade = () => push('/(modals)/propose-trade')
    const needsCount = incomingTrades.length + vetoableTrades.length + outgoingTrades.length
    const offersEmpty = tab === 'offers' && !activeTabLoading && !tradesError && needsCount === 0
    const needsKnown = tab === 'offers' && (offersHaveData || (online && !tradesError && !activeTabLoading))
    const tradeTabs = (
        <SegmentedControl<TradeTabKey> variant="tabs" equalWidth options={tabOptions} value={tab} onChange={changeTab}
            idBase="trade-section" accessibilityLabel="Trade sections" />
    )
    const needsCard = needsKnown ? (
        <TradeNeedsCard
            incoming={incomingTrades.length}
            awaitingVote={vetoableTrades.length}
            outgoing={outgoingTrades.length}
            proposeDisabled={!online || tradingClosed}
            proposeLabel={!online ? 'Offline' : tradingClosed ? 'Locked' : 'Propose trade'}
            onPropose={proposeTrade}
        />
    ) : null
    const needsHeader = needsCard ? <View style={styles.needsHeader}>{needsCard}</View> : null

    if (memberships.length === 0 && leagueLoading) {
        return <Page title="Trades"><PageHeader tabs={tradeTabs} /></Page>
    }
    if (memberships.length === 0) return <NoLeagueState />

    const tradeContext = openTrade ? {
        trade: openTrade,
        myMemberId,
        tab,
        holdReady,
        tradeVetoMode: currentLeague?.trade_veto_mode ?? 'member_vote',
        isCommissioner,
    } : null
    const detailActions = openTrade ? {
        acting: tradeActions.busyTradeId !== null || decisionsDisabled,
        onAccept: () => tradeActions.accept(openTrade),
        onRosterPlan: (plan: import('@/lib/trades').TradeRosterPlan) => tradeActions.setRosterPlan(openTrade, plan),
        onTaxiDestination: (playerId: string, value: boolean) => tradeActions.setTaxiDestination(openTrade, playerId, value),
        onReject: () => tradeActions.reject(openTrade.id),
        onVeto: () => tradeActions.veto(openTrade.id),
        onWithdraw: () => tradeActions.withdraw(openTrade.id),
        onWithdrawAcceptance: () => tradeActions.retractAcceptance(openTrade.id),
    } : null
    const list = (
        <FlashList onScroll={statusScroll.onScroll} scrollEventThrottle={16} data={listData} keyExtractor={tradeListKey} getItemType={tradeListItemType}
            key={`${tab}:${gridColumns}`}
            numColumns={gridColumns}
            ListHeaderComponent={needsHeader ?? undefined}
            overrideItemLayout={(itemLayout, item, _index, maxColumns) => {
                if (item._type === 'header' || item._type === 'empty') itemLayout.span = maxColumns
            }}
            ItemSeparatorComponent={gridColumns > 1 ? CardGap : undefined}
            renderItem={renderItem}
            contentContainerStyle={statusScroll.contentStyle({ paddingHorizontal: padX, paddingTop: spacing.md, paddingBottom: spacing['3xl'] })}
            onEndReached={tab === 'history' && historyHasMore
                ? loadMoreHistory
                : tab === 'offers' && offersHaveMore && !offersLoadingMore ? loadMoreOffers : undefined}
            onEndReachedThreshold={0.4} />
    )

    const resourceStatus = <ScreenStatusOverlay>
        {activeError ? <ErrorBanner message={hasSavedData
            ? `${resourceLabel[0].toUpperCase() + resourceLabel.slice(1)} refresh failed. Showing a saved snapshot.${online ? ' Tap to retry.' : ' Reconnect to update.'}`
            : `${online ? 'Could not load' : 'Offline. No saved'} ${resourceLabel}.${online ? ' Tap to retry.' : ' Reconnect to load.'}`}
            onRetry={() => { if (online) void retryActiveResource() }} />
            : hasSavedData && isSnapshot && !online ? <Text style={styles.freshness} accessibilityLiveRegion="polite">
                {`Offline. Showing a saved ${resourceLabel} snapshot.`}
            </Text> : null}
    </ScreenStatusOverlay>

    if (tradeContext && detailActions) return <Page title="Trade details">
        <PageHeader title={tradeCardModel(tradeContext).opponentName} showTitle onBack={() => setOpenTradeId(null)} backLabel="Back to trades" />
        <ScrollView contentContainerStyle={styles.tradeDetails}>
            <TradeDetailsPanel context={tradeContext} actions={detailActions} analysisDisabled={tradeActions.busyTradeId !== null} showHeader={false}
                onAnalyze={() => { setOpenTradeId(null); openAnalyzer(tradeContext.trade) }} />
        </ScrollView>
        {resourceStatus}
        {rosterLegality.modalProps.visible ? <IRResolutionModal {...rosterLegality.modalProps} /> : null}
    </Page>

    if (ownedAnalyzerTrade || tab === 'analyzer') return <Page title="Trade analysis">
        <PageHeader tabs={tradeTabs} />
        <Suspense fallback={<View style={styles.loading} aria-busy accessibilityState={{ busy: true }} />}>
            <TradeAnalyzer key={`${user?.id}:${leagueId}:${myMemberId}`} prefillTrade={ownedAnalyzerTrade} />
        </Suspense>
        {resourceStatus}
    </Page>

    return <Page title="Trades">
        <PageHeader tabs={tradeTabs} />
        {!activeError && activeActionError ? <ErrorBanner message={`${activeActionError.replace(/[.!]?\s*$/, '.')} Tap to refresh.`}
            onRetry={() => { void retryActiveResource() }} /> : null}
        <DeferredContent ready={!activeTabLoading}>
        {activeTabLoading ? <View style={styles.loading} aria-busy accessibilityState={{ busy: true }} />
                    : gridColumns === 1 && (staticTradeList || tab === 'block' || listData.every((item) => item._type === 'empty')) ? (
                        <ScrollView contentContainerStyle={{ paddingHorizontal: padX, paddingTop: spacing.md, paddingBottom: spacing['3xl'] }}>
                            {needsHeader}
                            {(offersEmpty ? [] : listData).map((item, index) => <View key={tradeListKey(item, index)}>
                                {renderItem({ item, index })}
                            </View>)}
                        </ScrollView>
                    ) : list}
        </DeferredContent>
        {resourceStatus}
        {rosterLegality.modalProps.visible ? <IRResolutionModal {...rosterLegality.modalProps} /> : null}
    </Page>
}

const styles = StyleSheet.create({
    freshness: { ...typeScale.small, color: colors.textSecondary, paddingHorizontal: spacing.xl, paddingVertical: spacing.sm },
    needsHeader: { paddingBottom: spacing.md },
    cardGap: { height: spacing.md },
    tradeDetails: { padding: spacing.lg, paddingBottom: spacing['3xl'] },
    loading: { flex: 1, minHeight: layout.loadingMinHeight },
})

export default function TradesScreenWithStatus() {
    return <ScreenStatusProvider><TradesScreen /></ScreenStatusProvider>
}
