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
import { colors, controlSize, fontSize, layout, spacing, textStyles } from '@/constants/tokens'
import { SegmentedControl, type SegmentOption } from '@/components/ui/SegmentedControl'
import { Button, ErrorBanner, Page, PageHeader, usePageMetrics } from '@/components/ui'
import { TradeDetailsPanel } from '@/components/trades/TradeDetailsPanel'
import { tradeCardModel } from '@/components/trades/TradeCard'
import { normalizeTradeTab, type TradeTabKey } from '@/lib/trade-ui-model'
import {
    TradeBlockListingRow,
    TradeBlockPickRow,
    TradeBlockPlayerRow,
    TradeEmptyRow,
    TradeOfferRow,
    TradeSectionRow,
} from '@/components/trades/TradeListRow'



import { useTradesFeed } from '@/hooks/use-trades-feed'
import { useTradeHistoryFeed } from '@/hooks/use-trade-history-feed'
import { useTradeBlock } from '@/hooks/use-trade-block'
import { useTradeActions } from '@/hooks/use-trade-actions'

import { useAuth } from '@/hooks/use-auth'
import {
    buildTradeScreenModel,
    tradeListItemType,
    tradeListKey,
    tradeScreenResource,
    type TradeListItem,
} from '@/lib/trades-screen-model'

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'


const TradeAnalyzer = lazy(() => import('@/components/trades/TradeAnalyzer'))
const STATIC_TRADE_LIMIT = 10

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
    const { compact, padX, usableWidth } = usePageMetrics()
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
    } = useTradesFeed(myMemberId, leagueId, online && tab === 'offers' && focused, { autoLoad: true })
    const {
        trades: historyTrades,
        hasData: historyHasData,
        loading: historyLoading,
        hasMore: historyHasMore,
        error: historyError,
        refresh: refreshHistoryFeed,
        loadMore: loadMoreHistory,
    } = useTradeHistoryFeed(myMemberId, leagueId, tab === 'history')
    const decisionsDisabled = online && (tradesSnapshot || Boolean(tradesError))
    const rosterLegality = useRosterLegality({ memberId: myMemberId, leagueId, rosterSize: currentLeague?.roster_size ?? 20, irSlots: currentLeague?.ir_slots ?? 2, onChanged: load })
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
    } = useTradeBlock(myMemberId, leagueId, true, { visible: focused && tab === 'block', allowInactive: currentLeague?.allow_inactive_trades ?? false })
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
    const { listData, pendingInboxCount } = screenModel
    const tradeTab = tab === 'offers' || tab === 'history'
    // Wide screens keep the offer list and the open trade side by side.
    const split = tradeTab && usableWidth >= SPLIT_MIN_WIDTH
    const gridColumns = tab === 'block' ? blockColumns(usableWidth) : 1
    const listTrades = useMemo(
        () => listData.flatMap((item) => (item._type === 'trade' ? [item.trade] : [])),
        [listData],
    )
    const staticTradeList = tradeTab && listTrades.length <= STATIC_TRADE_LIMIT && !(tab === 'offers' ? offersHaveMore : historyHasMore)
    const openTrade = (openTradeId ? listTrades.find((trade) => trade.id === openTradeId) : null)
        ?? (split ? listTrades[0] ?? null : null)
    const openTradeDetails = useCallback((trade: Trade) => setOpenTradeId(trade.id), [setOpenTradeId])
    const renderItem = useCallback(({ item }: { item: TradeListItem }) => {
        switch (item._type) {
            case 'header':
                return <TradeSectionRow item={item} />
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
                    onAccept={tradeActions.accept} onReject={tradeActions.reject}
                    onVeto={tradeActions.veto} onWithdraw={tradeActions.withdraw}
                    onAnalyze={openAnalyzer} selected={split && item.trade.id === openTrade?.id} brief={split}
                    onOpen={openTradeDetails} />
        }
    }, [blockAvgMap, blockAvgStatsMap, blockBusyId, decisionsDisabled, currentLeague?.trade_veto_mode, gridColumns, handleListPick, handleListPlayer,
        handleRemoveBlockItem, handleSaveBlockNote, isCommissioner, listedPickIds, listedPlayerIds, myMemberId, myTeamName,
        openAnalyzer, openTrade?.id, openTradeDetails, split, tab, tradeActions.accept, tradeActions.busyTradeId, tradeActions.reject,
        tradeActions.veto, tradeActions.withdraw])

    const activeTabLoading = tab === 'block' ? !blockDisplayReady || (picksLoading && picks === null)
        : tab === 'history' ? historyLoading && !historyHasData
            : loading && !offersHaveData
    const tabOptions: SegmentOption<TradeTabKey>[] = [
        { label: 'Offers', value: 'offers', badge: pendingInboxCount > 0 ? pendingInboxCount : undefined },
        { label: 'Block', value: 'block' },
        { label: 'History', value: 'history' },
        { label: 'Analyzer', value: 'analyzer' },
    ]
    const activeResource = tradeScreenResource(tab)
    const activeError = activeResource === 'block' ? blockError || picksError
            : activeResource === 'history' ? historyError
                : tradesError
    useLayoutEffect(() => {
        const listReady = tab === 'history' ? historyHasData : tab === 'offers' && offersHaveData
        if (listReady && openTradeId && !split && !activeTabLoading && !activeError && !openTrade) setOpenTradeId(null)
    }, [activeError, activeTabLoading, historyHasData, offersHaveData, openTrade, openTradeId, setOpenTradeId, split, tab])
    // A failed add/remove or a failed load-more is reported, but it is not a
    // failed load: the list (and its empty rows) stays as it is.
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
    const header = (disabled: boolean, onPropose: () => void) => (
        <PageHeader
            tabs={<TradeTabs options={tabOptions} tab={ownedAnalyzerTrade ? 'analyzer' : tab} setTab={changeTab} />}
            actions={(
                <Button
                    title={compact ? undefined : !online ? 'Offline' : disabled ? 'Locked' : 'Propose'}
                    icon={disabled ? 'lock' : 'add'}
                    size="inline"
                    style={{ minWidth: controlSize.minTouch }}
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
        onRosterPlan: (plan: import('@/lib/trades').TradeRosterPlan) => tradeActions.setRosterPlan(openTrade, plan),
        onTaxiDestination: (playerId: string, value: boolean) => tradeActions.setTaxiDestination(openTrade, playerId, value),
        onReject: () => tradeActions.reject(openTrade.id),
        onVeto: () => tradeActions.veto(openTrade.id),
        onWithdraw: () => tradeActions.withdraw(openTrade.id),
    } : null
    const list = (
        <FlashList onScroll={statusScroll.onScroll} scrollEventThrottle={16} data={listData} keyExtractor={tradeListKey} getItemType={tradeListItemType}
            key={`${tab}:${gridColumns}`}
            numColumns={gridColumns}
            overrideItemLayout={(itemLayout, item, _index, maxColumns) => {
                if (item._type === 'header' || item._type === 'empty') itemLayout.span = maxColumns
            }}
            ItemSeparatorComponent={tradeTab ? CardGap : undefined}
            renderItem={renderItem}
            contentContainerStyle={statusScroll.contentStyle({ paddingHorizontal: padX, paddingBottom: spacing['3xl'] })}
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

    if (!split && tradeContext && detailActions) return <Page title="Trade details">
        <PageHeader title={tradeCardModel(tradeContext).opponentName} onBack={() => setOpenTradeId(null)} backLabel="Back to trades" />
        <ScrollView contentContainerStyle={styles.tradeDetails}>
            <TradeDetailsPanel context={tradeContext} actions={detailActions} showHeader={false}
                onAnalyze={() => { setOpenTradeId(null); openAnalyzer(tradeContext.trade) }} />
        </ScrollView>
        {resourceStatus}
        {rosterLegality.modalProps.visible ? <IRResolutionModal {...rosterLegality.modalProps} /> : null}
    </Page>

    if (ownedAnalyzerTrade || tab === 'analyzer') return <Page title="Trade analysis">
        {header(!online || tradingClosed, () => push('/(modals)/propose-trade'))}
        <Suspense fallback={<View style={styles.loading} aria-busy accessibilityState={{ busy: true }} />}>
            <TradeAnalyzer key={`${user?.id}:${leagueId}:${myMemberId}`} prefillTrade={ownedAnalyzerTrade} />
        </Suspense>
        {resourceStatus}
    </Page>

    return <Page title="Trades">
        {header(!online || tradingClosed, () => push('/(modals)/propose-trade'))}
        {!activeError && activeActionError ? <ErrorBanner message={`${activeActionError.replace(/[.!]?\s*$/, '.')} Tap to refresh.`}
            onRetry={() => { void retryActiveResource() }} /> : null}
        <DeferredContent ready={!activeTabLoading}>
        {activeTabLoading ? <View style={styles.loading} aria-busy accessibilityState={{ busy: true }} />
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
                    : gridColumns === 1 && (staticTradeList || tab === 'block' || listData.every((item) => item._type === 'empty')) ? (
                        <ScrollView contentContainerStyle={{ paddingHorizontal: padX, paddingBottom: spacing['3xl'] }}>
                            {listData.map((item, index) => <View key={tradeListKey(item, index)}>
                                {index > 0 && tradeTab ? <CardGap /> : null}
                                {renderItem({ item })}
                            </View>)}
                        </ScrollView>
                    ) : list}
        </DeferredContent>
        {resourceStatus}
    </Page>
}

function TradeTabs({ options, tab, setTab }: { options: SegmentOption<TradeTabKey>[]; tab: TradeTabKey; setTab: (tab: TradeTabKey) => void }) {
    return <SegmentedControl variant="tabs" scrollable options={options} value={tab} onChange={setTab}
            idBase="trade-section" style={styles.tabOptions} accessibilityLabel="Trade sections" />
}

const styles = StyleSheet.create({
    freshness: { color: colors.textSecondary, fontSize: fontSize.sm, paddingHorizontal: spacing.xl, paddingVertical: spacing.sm },
    tabOptions: { flexWrap: 'nowrap' },
    cardGap: { height: spacing.md },
    tradeDetails: { padding: spacing.lg, paddingBottom: spacing['3xl'] },
    split: { flex: 1, minHeight: 0, flexDirection: 'row' },
    splitList: { width: SPLIT_LIST_WIDTH, flexShrink: 0 },
    splitDetail: { flex: 1, borderLeftWidth: 1, borderLeftColor: colors.borderLight },
    splitDetailContent: { maxWidth: layout.formMaxWidth, padding: spacing['3xl'] },
    detailHint: { ...textStyles.meta, paddingTop: spacing['4xl'], textAlign: 'center' },
    loading: { flex: 1, minHeight: layout.loadingMinHeight },
})

export default function TradesScreenWithStatus() {
    return <ScreenStatusProvider><TradesScreen /></ScreenStatusProvider>
}
