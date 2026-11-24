import { STATS_WINDOW_OPTIONS, statsWindowDays, statsWindowLabel } from '@/lib/stats-window'
import { readScreenSection, saveScreenSection } from '@/lib/screen-section'
import { ListHeader } from '@/components/ui/ListHeader'
import { useScrollRestoration } from '@/lib/scroll-restoration'
import { WaiversSection } from '@/components/waivers/WaiversSection'
import { ScreenStatusOverlay, ScreenStatusProvider, useScreenStatusScroll } from '@/components/ui/ScreenStatusOverlay'
import { useIsFocused } from '@react-navigation/native'
import {
    View,
    Text,
    TextInput,
    Pressable,
    StyleSheet,
    useWindowDimensions,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { type OwnedEntry } from '@/lib/roster'
import { useLeagueContext } from '@/contexts/league-context'
import { colors, controlSize, fontWeight, radii, spacing, textStyles, typeScale } from '@/constants/tokens'
import { EmptyState } from '@/components/EmptyState'
import { IRResolutionModal } from '@/components/IRResolutionModal'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { playerDetailRoute } from '@/components/player/navigation'
import { PlayerSearchItem } from '@/components/PlayerSearchItem'
import { NoLeagueState } from '@/components/NoLeagueState'
import { FilterSelect, MultiSelect, Page, PageHeader, SegmentedControl, usePageMetrics } from '@/components/ui'
import { Sheet } from '@/components/ui/Sheet'
import { DynastyHub } from '@/components/dynasty/DynastyHub'
import { RetainedPanel } from '@/components/ui/RetainedPanel'
import { playerListStyles as styles } from '@/components/ui/playerListStyles'
import { NBA_TEAM_OPTIONS } from '@/constants/nba'

import { usePlayerSearch, useVisiblePlayerRows, SORT_OPTIONS } from '@/hooks/use-player-search'
import { useAuth } from '@/hooks/use-auth'
import { STAT_COLUMN_SORT, type PlayerSearchSortMode } from '@/lib/player-search-sort'
import {
    PLAYER_AVAILABILITY_FILTERS,
    PLAYER_CLASS_FILTERS,
    PLAYER_HEALTH_FILTERS,
    PLAYER_PLAYING_FILTERS,
    PLAYER_POSITION_FILTERS,
    playerAverageLabel,
    playerSeasonFilterOptions,
} from '@/lib/player-search-state'

import { currentSeasonYear } from '@/lib/shared/season'
import { useQuickAdd, type PickupClaimSelection } from '@/hooks/use-quick-add'
import { partitionRoster, rosterLimits } from '@/lib/roster-capacity'
import { useRosterHoldCheck } from '@/hooks/use-roster-hold-check'
import { addLimitSummary } from '@/lib/pickup'
import { PlayerRow } from '@/lib/players'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { readsAllowed } from '@/lib/lifecycle'






const SEASON_YEAR = currentSeasonYear()
const SEASON_FILTERS = playerSeasonFilterOptions(SEASON_YEAR)
const TABLE_COLUMNS = ['FP', 'MIN', 'PTS', 'REB', 'AST', 'STL', 'BLK', '3PM', 'TO', 'GP']
const STAT_LABELS: Record<string, string> = {
    FP: 'Fantasy points', PTS: 'Points', REB: 'Rebounds', AST: 'Assists', STL: 'Steals',
    BLK: 'Blocks', '3PM': 'Three-pointers made', TO: 'Turnovers', GP: 'Games played', MIN: 'Minutes',
}

const EMPTY_OWNED_MAP = new Map<string, OwnedEntry>()
const EMPTY_WAIVER_IDS = new Set<string>()





function PlayerTableHeader({
    activeSort,
    sortDir,
    onColumnSort,
}: {
    activeSort?: PlayerSearchSortMode
    sortDir?: 'asc' | 'desc'
    onColumnSort?: (mode: PlayerSearchSortMode) => void
}) {
    return (
        <ListHeader interactive style={[styles.tableHeader, { paddingRight: spacing.sm }]}>
            <View style={styles.tableHeaderCardRow}>
                <View style={styles.tableHeaderHeadshotSpacer} />
                <Text style={styles.tableHeaderPlayer}>Player</Text>
                <View style={styles.tableHeaderStatsGroup}>
                    {TABLE_COLUMNS.map((column) => {
                        const mode = STAT_COLUMN_SORT[column]
                        const active = mode != null && activeSort === mode
                        const disabled = mode == null || !onColumnSort
                        return (
                            <Pressable
                                key={column}
                                style={styles.tableHeaderStatBtn}
                                onPress={() => mode && onColumnSort?.(mode)}
                                disabled={disabled}
                                accessibilityRole="button"
                                accessibilityState={{ selected: active, disabled }}
                                accessibilityLabel={mode
                                    ? `Sort by ${STAT_LABELS[column] ?? column}${active && sortDir ? (sortDir === 'asc' ? ', ascending' : ', descending') : ''}`
                                    : STAT_LABELS[column] ?? column}
                            >
                                <Text style={[styles.tableHeaderStat, active && styles.tableHeaderStatActive]} numberOfLines={1}>
                                    {column}{active && sortDir ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                                </Text>
                            </Pressable>
                        )
                    })}
                </View>
            </View>
            <View style={styles.tableHeaderAddSpacer} />
        </ListHeader>
    )
}

function PlayerSearchSection() {
    const statusScroll = useScreenStatusScroll()
    const { push } = useRouter()
    const { user, loading: authLoading } = useAuth()
    const { memberships, current, currentLeague, loading: leagueLoading, online, membershipValidated } = useLeagueContext()
    const focused = useIsFocused()
    const { width } = useWindowDimensions()
    const leagueId = currentLeague?.id ?? null

    const searchEnabled = membershipValidated && !!user && !!current?.id && !!leagueId
    const { compact: compactToolbar, padX } = usePageMetrics()
    const showStatTable = width >= 1180
    const [filtersOpen, setFiltersOpen] = useState(false)

    const search = usePlayerSearch(leagueId, EMPTY_OWNED_MAP, EMPTY_WAIVER_IDS, current?.id, { enabled: searchEnabled, online, focused, ownerId: user?.id, initialLiveStats: true, scoringSettings: currentLeague?.scoring_settings })
    const refreshSearchView = search.refresh
    const playerSupportForLeague = search.support
    const ownedMap = playerSupportForLeague?.ownedMap ?? EMPTY_OWNED_MAP
    const waiverIds = playerSupportForLeague?.waiverIds ?? EMPTY_WAIVER_IDS
    const playerSupportFetchLoading = search.results.loading
    const playerSupportRefreshing = search.results.refreshing
    const playerSupportError = search.results.error
    const supportSnapshot = search.results.isSnapshot
    const playerSupportLoading = !!leagueId && playerSupportFetchLoading && !playerSupportForLeague
    const playerSupportReady = !leagueId || Boolean(playerSupportForLeague)
    const transactionState = playerSupportForLeague?.transactionState ?? null
    const refreshPlayerSupport = useCallback(async () => { await refreshSearchView(true) }, [refreshSearchView])
    const scrollRestoration = useScrollRestoration(JSON.stringify(['players', user?.id, current?.id, leagueId, search.search.query, search.season.value, search.statsWindow.days, search.sort.mode, search.sort.dir, search.availabilityFilter.value, search.position.value, search.teamPicker.selectedTeams, search.playing.value, search.health.value, search.toggles]), search.results.listRef)
    const liveRows = useVisiblePlayerRows(search.results.players, leagueId, search.season.value,
        currentLeague?.scoring_settings, {
            enabled: focused && online && membershipValidated && !filtersOpen,
            ownerKey: JSON.stringify([user?.id, current?.id, leagueId]),
            initialTotals: search.results.totalsSnapshot,
        })
    const retrySearch = search.results.retry
    const refreshPlayers = useCallback(() => {
        const support = refreshPlayerSupport()
        retrySearch()
        return support
    }, [retrySearch, refreshPlayerSupport])


    const handleColumnSort = (mode: PlayerSearchSortMode) => {
        if (search.sort.mode === mode) {
            search.sort.setDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
        } else {
            search.sort.setMode(mode)
            search.sort.setDir('desc')
        }
    }
    const openClaim = useCallback((player: Pick<PlayerRow, 'id'>, selection?: PickupClaimSelection) => {
        if (selection) push({ pathname: '/(modals)/claim-player', params: { playerId: player.id, ...selection } })
        else push(`/(modals)/claim-player?playerId=${player.id}`)
    }, [push])
    const limits = useMemo(() => rosterLimits(currentLeague), [currentLeague])
    const quickAdd = useQuickAdd({
        memberId: current?.id,
        leagueId,
        onChanged: refreshPlayerSupport,
        transactionState,
        limits,
        onClaimInstead: openClaim,
    })
    const holdCheck = useRosterHoldCheck({
        memberId: current?.id,
        addPlayerId: quickAdd.dropPickerPlayer?.id ?? null,
        enabled: quickAdd.dropPickerPlayer != null,
    })
    const availabilityUpdating = supportSnapshot || playerSupportFetchLoading || playerSupportRefreshing || Boolean(playerSupportError)
    const addBlockedReason = quickAdd.addBlockedReason
    const { handleAdd: quickAddHandleAdd, handleClaim: quickAddHandleClaim } = quickAdd
    const handleAddPlayer = useCallback((player: PlayerRow) => {
        if (availabilityUpdating && online) return
        if (playerSupportForLeague?.pendingClaimIds.has(player.id)) push('/players?section=waivers')
        else if (waiverIds.has(player.id)) void quickAddHandleClaim(player)
        else void quickAddHandleAdd(player)
    }, [online, availabilityUpdating, waiverIds, playerSupportForLeague?.pendingClaimIds, push, quickAddHandleClaim, quickAddHandleAdd])
    const handleOpenPlayer = useCallback((player: PlayerRow) => {
        push(playerDetailRoute(player, !ownedMap.has(player.id)))
    }, [push, ownedMap])
    const handlePreparePlayer = useCallback(() => {
        if (readsAllowed()) void import('@/app/player/[id]').catch(() => undefined)
    }, [])
    const renderPlayerItem = useCallback(({ item }: { item: PlayerRow }) => (
        <PlayerSearchItem
            item={item}
            currentMemberId={current?.id}
            ownedMap={ownedMap}
            waiverIds={waiverIds}
            waiverClearsAt={playerSupportForLeague?.waiverClearsAt.get(item.id) ?? null}
            claimPending={playerSupportForLeague?.pendingClaimIds.has(item.id) ?? false}
            isAdding={quickAdd.adding === item.id}
            addDisabled={online && availabilityUpdating}
            statMode={search.statsWindow.days === null ? 'season' : 'window'}
            showStats={showStatTable}
            showCompactStats={false}
            animate={false}
            addBlockedReason={addBlockedReason}
            onAdd={handleAddPlayer}
            onPress={handleOpenPlayer}
            onPrepare={handlePreparePlayer}
        />
    ), [search.statsWindow.days, current?.id, online, availabilityUpdating, ownedMap, waiverIds, playerSupportForLeague?.waiverClearsAt, playerSupportForLeague?.pendingClaimIds, quickAdd.adding, showStatTable, addBlockedReason, handleAddPlayer, handleOpenPlayer, handlePreparePlayer])
    const playerListExtraData = [
        search.sort.mode,
        search.sort.dir,
        search.availabilityFilter.value,
        search.playing.value,
        search.health.value,
        search.teamPicker.selectedTeams.join(','),
        search.season.value ?? '',
        search.statsWindow.days ?? '',
    ].join('|')
    const showInitialShell = authLoading || (leagueLoading && memberships.length === 0)
    const resultCount = search.results.players.length
    const resultCountLabel = resultCount === 0 && (search.results.loading || search.results.isSnapshot)
        ? ''
        : `${resultCount}${search.activeFilterCount > 0 ? ' filtered' : ''} player${resultCount === 1 ? '' : 's'}`
    const waiverLine = transactionState
        ? transactionState.waiverMode === 'faab'
            ? `FAAB $${transactionState.faabBalance}`
            : 'Rolling waivers'
        : ''
    const averageLabel = search.statsWindow.days === null
        ? playerAverageLabel(search.results.players[0]?.stats_season_year)
        : statsWindowLabel(search.statsWindow.range)
    const summaryLoading = !playerSupportReady || (search.results.players.length === 0 && search.results.loading)
    const summaryLine = [resultCountLabel, averageLabel, addLimitSummary(transactionState, Date.now(), currentLeague?.timezone), waiverLine].filter(Boolean).join(' · ')
    const filterControls = (variant: 'chip' | 'field') => (
        <>
            <FilterSelect
                variant={variant}
                label="Availability"
                value={search.availabilityFilter.value}
                options={PLAYER_AVAILABILITY_FILTERS}
                onChange={search.availabilityFilter.setValue}
            />
            <FilterSelect
                variant={variant}
                label="Position"
                value={search.position.value}
                options={PLAYER_POSITION_FILTERS}
                onChange={search.position.setValue}
            />
            <MultiSelect
                variant={variant}
                label="Team"
                options={NBA_TEAM_OPTIONS}
                selected={search.teamPicker.selectedTeams}
                onChange={search.teamPicker.setSelectedTeams}
                pluralLabel="teams"
                clearAccessibilityLabel="Clear teams"
            />
            <FilterSelect
                variant={variant}
                label="Health"
                value={search.health.value}
                options={PLAYER_HEALTH_FILTERS}
                onChange={search.health.setValue}
            />
            <FilterSelect
                variant={variant}
                label="Game today"
                value={search.playing.value}
                options={PLAYER_PLAYING_FILTERS}
                onChange={search.playing.setValue}
            />
            <FilterSelect
                variant={variant}
                label="Experience"
                value={search.toggles.rookiesOnly ? 'rookies' : 'all'}
                options={PLAYER_CLASS_FILTERS}
                onChange={(value) => search.toggles.setRookiesOnly(value === 'rookies')}
            />
            <FilterSelect
                variant={variant}
                label="Sort"
                value={search.sort.mode}
                options={SORT_OPTIONS}
                onChange={(value) => {
                    search.sort.setMode(value)
                    search.sort.setDir('desc')
                }}
            />
            {search.availabilityFilter.value !== 'mine' ? <FilterSelect
                variant={variant}
                label="Statistics"
                value={String(search.statsWindow.days ?? 'season')}
                options={STATS_WINDOW_OPTIONS}
                onChange={(value) => { search.statsWindow.setDays(statsWindowDays(value)); search.season.setValue(null) }}
            /> : null}
            {search.statsWindow.days === null ? <FilterSelect
                variant={variant}
                label="Season"
                value={String(search.season.value ?? 'auto')}
                options={SEASON_FILTERS}
                onChange={(value) => search.season.setValue(value === 'auto' ? null : Number(value))}
            /> : null}
        </>
    )
    const listError = search.results.error ?? playerSupportError
    const listIsInitialLoading = !listError && (playerSupportLoading || availabilityUpdating || !playerSupportReady
        || search.results.loading || search.results.refreshing || search.results.isSnapshot)

    if (showInitialShell) {
        return <View style={styles.container} />
    }
    if (!user) return <NoLeagueState />
    if (memberships.length === 0 || !current || !leagueId) return <NoLeagueState />

    return (
        <View style={styles.container}>
          <View style={styles.contentWrap}>
            <View style={[localStyles.toolbar, { paddingHorizontal: padX }]}>
                <View style={localStyles.toolbarRow}>
                    <TextInput
                        style={[styles.searchInput, !compactToolbar && localStyles.searchWide]}
                        placeholder="Search players..."
                        placeholderTextColor={colors.inputPlaceholder}
                        value={search.search.query}
                        onChangeText={search.search.setQuery}
                        autoCorrect={false}
                        clearButtonMode="while-editing"
                        accessibilityLabel="Search players"
                    />
                    {compactToolbar ? (
                        <Pressable
                            style={[localStyles.filterButton, search.activeFilterCount > 0 && localStyles.filterButtonActive]}
                            onPress={() => setFiltersOpen(true)}
                            accessibilityRole="button"
                            accessibilityLabel="Show filters"
                        >
                            <Text style={[localStyles.filterButtonText, search.activeFilterCount > 0 && localStyles.filterButtonTextActive]}>Filters</Text>
                            {search.activeFilterCount > 0 ? (
                                <View style={styles.filterCountDot}>
                                    <Text style={styles.filterCountDotText}>{search.activeFilterCount}</Text>
                                </View>
                            ) : null}
                        </Pressable>
                    ) : (
                        <>
                            {filterControls('chip')}
                            {search.activeFilterCount > 0 ? (
                                <Pressable onPress={search.clearAllFilters} style={localStyles.clearButton} accessibilityRole="button" accessibilityLabel="Clear all filters">
                                    <Text style={localStyles.clearButtonText}>Clear</Text>
                                </Pressable>
                            ) : null}
                            <Text style={[localStyles.summary, localStyles.summaryWide, { minWidth: 240, minHeight: textStyles.body.lineHeight, opacity: summaryLoading ? 0 : 1 }]} aria-busy={summaryLoading} accessibilityState={{ busy: summaryLoading }}>{resultCountLabel ? summaryLine : ''}</Text>
                        </>
                    )}
                </View>
                {compactToolbar ? <Text style={[localStyles.summary, { minWidth: 240, minHeight: textStyles.body.lineHeight, opacity: summaryLoading ? 0 : 1 }]} aria-busy={summaryLoading} accessibilityState={{ busy: summaryLoading }}>{resultCountLabel ? summaryLine : ''}</Text> : null}
                {addBlockedReason ? (
                    <Text
                        style={localStyles.addLimitNotice}
                        accessibilityLiveRegion="polite"
                        role="status"
                        testID="add-limit-notice"
                    >
                        {addBlockedReason}
                    </Text>
                ) : null}
            </View>

            <Sheet visible={compactToolbar && filtersOpen} title="Filters" onClose={() => setFiltersOpen(false)}>
                <View style={localStyles.sheetFields}>
                    {filterControls('field')}
                    <Pressable
                        style={[styles.sortDirButton, localStyles.sortDirInSheet]}
                        disabled={search.sort.mode === 'dynasty'}
                        onPress={() => search.sort.setDir((dir) => dir === 'asc' ? 'desc' : 'asc')}
                        accessibilityRole="button"
                    >
                        <Text style={styles.sortDirText}>{search.sort.mode === 'dynasty' ? 'Best rank first' : search.sort.dir === 'asc' ? 'Lowest first ↑' : 'Highest first ↓'}</Text>
                    </Pressable>
                </View>
                <View style={localStyles.sheetActions}>
                    {search.activeFilterCount > 0 ? (
                        <Pressable onPress={search.clearAllFilters} style={localStyles.sheetClear} accessibilityRole="button" accessibilityLabel="Clear all filters">
                            <Text style={localStyles.clearButtonText}>Clear all</Text>
                        </Pressable>
                    ) : null}
                    <Pressable onPress={() => setFiltersOpen(false)} style={localStyles.sheetDone} accessibilityRole="button">
                        <Text style={localStyles.sheetDoneText}>{`Show ${resultCountLabel}`}</Text>
                    </Pressable>
                </View>
            </Sheet>

            <View style={localStyles.results} aria-busy={listIsInitialLoading || search.results.loadingMore} accessibilityState={{ busy: listIsInitialLoading || search.results.loadingMore }}>
            <FlashList
                    {...scrollRestoration}
                    onScroll={event => { statusScroll.onScroll?.(event); scrollRestoration.onScroll(event) }}
                    scrollEventThrottle={16}
                    ref={search.results.listRef}
                    data={liveRows.rows}
                    onViewableItemsChanged={liveRows.onViewableItemsChanged}
                    extraData={playerListExtraData}
                    keyExtractor={(p: PlayerRow) => p.id}
                    contentContainerStyle={statusScroll.contentStyle(search.results.players.length === 0 && !listIsInitialLoading ? styles.emptyContainer : undefined)}
                    ListHeaderComponent={showStatTable ? (
                        <PlayerTableHeader activeSort={search.sort.mode} sortDir={search.sort.dir} onColumnSort={handleColumnSort} />
                    ) : null}
                    renderItem={renderPlayerItem}
                    ListEmptyComponent={
                        !online
                            ? <EmptyState message="Offline. No saved player results." description="Reconnect to load this search." fullScreen={false} />
                            : listError
                              ? <EmptyState message="Players could not load." description={listError.message} actionLabel="Retry" onAction={() => { void refreshPlayers() }} fullScreen={false} />
                            : listIsInitialLoading
                              ? <EmptyState message="Loading players…" fullScreen={false} />
                            : search.activeFilterCount > 0
                              ? <EmptyState message="No players match these filters." actionLabel="Clear filters" onAction={search.clearAllFilters} fullScreen={false} />
                            : search.search.query.trim()
                              ? <EmptyState message={`No players match "${search.search.query.trim()}".`} actionLabel="Clear search" onAction={() => search.search.setQuery('')} fullScreen={false} />
                            : search.availabilityFilter.value === 'free_agents'
                              ? <EmptyState message="No free agents right now." description="Every player is on a roster or on waivers." actionLabel="Show all players" onAction={() => search.availabilityFilter.setValue('all')} fullScreen={false} />
                            : <EmptyState message="No players found." fullScreen={false} />
                    }
                    onEndReached={search.results.loadMore}
                    onEndReachedThreshold={0.3}
                    ListFooterComponent={
                        <View style={localStyles.pageProgress}>
                            <Text style={localStyles.freshnessText} accessibilityLiveRegion="polite">{search.results.loadingMore ? 'Loading more players…' : ''}</Text>
                        </View>
                    }
                />
            </View>
          </View>
            <ScreenStatusOverlay>
                {search.results.players.length > 0 && (!online || search.results.error || playerSupportError) && <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Refresh player data"
                    disabled={!online || search.results.refreshing}
                    onPress={() => { void refreshPlayers() }}
                    style={localStyles.freshness}
                >
                    <Text style={localStyles.freshnessText} accessibilityLiveRegion="polite">
                        {!online ? 'Offline. Saved player results may be out of date.'
                            : 'Player refresh failed. Saved results may be out of date. Tap to retry.'}
                    </Text>
                </Pressable>}
            </ScreenStatusOverlay>

            <DropPlayerPickerModal
                visible={quickAdd.dropPickerPlayer !== null}
                title={`Add ${quickAdd.dropPickerPlayer?.display_name ?? 'player'}`}
                roster={quickAdd.myRoster}
                dropping={quickAdd.dropping ?? quickAdd.adding}
                onDrop={quickAdd.handleDropAndAdd}
                destinations={quickAdd.dropDestinations}
                onAdd={quickAdd.taxiAvailable && quickAdd.canAddActive ? quickAdd.handleAddActive : undefined}
                onAddToTaxi={quickAdd.taxiAvailable ? quickAdd.handleAddToTaxi : undefined}
                irMoveCandidates={quickAdd.irMoveCandidates}
                onMoveToIR={quickAdd.handleMoveToIRAndAdd}
                holdConflicts={holdCheck.conflicts}
                onWithdrawHold={holdCheck.withdraw}
                withdrawingHoldTradeId={holdCheck.withdrawingTradeId}
                holdNotice={holdCheck.withdrawNotice}
                onCancel={() => quickAdd.setDropPickerPlayer(null)}
            />

            <IRResolutionModal
                visible={quickAdd.irModal !== null}
                serverMessage={quickAdd.irModal?.serverMessage}
                ineligibleIR={quickAdd.irModal?.ineligible ?? []}
                activeRoster={partitionRoster(quickAdd.irModal?.roster ?? []).active}
                rosterSize={limits?.rosterSize}
                pendingPlayerName={quickAdd.irModal?.pendingPlayer.display_name ?? ''}
                onActivate={quickAdd.handleIRActivate}
                onDrop={quickAdd.handleResolutionDrop}
                onMoveToIR={quickAdd.handleResolutionMoveToIR}
                irAvailable={limits != null && partitionRoster(quickAdd.irModal?.roster ?? []).ir.length < limits.irSlots}
                onDropAndActivate={quickAdd.handleDropAndIRActivate}
                onSwapWithInjured={quickAdd.handleSwapWithInjured}
                onCancel={() => quickAdd.setIrModal(null)}
            />
        </View>
    )
}

type PlayersSection = 'players' | 'waivers' | 'rankings' | 'news'
const SECTIONS: PlayersSection[] = ['players', 'waivers', 'rankings', 'news']

function initialSection(value: string | string[] | undefined): PlayersSection {
    return SECTIONS.find((section) => section === value) ?? 'players'
}

function PlayersScreen() {
    const focused = useIsFocused()
    const params = useLocalSearchParams<{ section?: string }>()
    const { setParams } = useRouter()
    const { user, loading: authLoading } = useAuth()
    const { memberships, current, loading: leagueLoading } = useLeagueContext()
    const [section, setSection] = useState<PlayersSection>(() => initialSection(params.section ?? readScreenSection(user?.id, current?.id, 'players')))
    const [opened, setOpened] = useState<Set<PlayersSection>>(() => new Set([initialSection(params.section ?? readScreenSection(user?.id, current?.id, 'players'))]))

    useEffect(() => {
        const saved = params.section ?? readScreenSection(user?.id, current?.id, 'players')
        if (!saved) return
        const next = initialSection(saved)
        saveScreenSection(user?.id, current?.id, 'players', next)
        setSection(next)
        setOpened((prev) => (prev.has(next) ? prev : new Set(prev).add(next)))
    }, [params.section, user?.id, current?.id])

    const [lastDynasty, setLastDynasty] = useState<'rankings' | 'news'>('rankings')
    const openSection = useCallback((next: PlayersSection) => {
        if (next === 'rankings' || next === 'news') setLastDynasty(next)
        saveScreenSection(user?.id, current?.id, 'players', next)
        setSection(next)
        setOpened((prev) => (prev.has(next) ? prev : new Set(prev).add(next)))
        setParams({ section: next })
    }, [user?.id, current?.id, setParams])

    if (authLoading || (leagueLoading && memberships.length === 0)) return <View style={styles.container} />
    if (!user || memberships.length === 0) return <NoLeagueState />

    return (
        <Page title="Players">
            <PageHeader
                tabs={(
                    <SegmentedControl<PlayersSection>
                        variant="tabs"
                        value={section}
                        onChange={openSection}
                        options={[
                            { label: 'Players', value: 'players', accessibilityLabel: 'Show player search' },
                            { label: 'Waivers', value: 'waivers' },
                            { label: 'Rankings', value: 'rankings' },
                            { label: 'News', value: 'news' },
                        ]}
                        accessibilityLabel="Players sections"
                        idBase="players-section"
                        controlledPanelId="players-section-panel"
                        scrollable
                    />
                )}
            />
            <View style={localStyles.panel} nativeID="players-section-panel" role="tabpanel">
                {opened.has('players') ? (
                    <RetainedPanel active={focused && section === 'players'}>
                        <PlayerSearchSection />
                    </RetainedPanel>
                ) : null}
                {opened.has('waivers') ? <RetainedPanel active={focused && section === 'waivers'}><WaiversSection active={focused && section === 'waivers'} onFindPlayer={() => openSection('players')} /></RetainedPanel> : null}
                {/* Rankings and News share one instance, so each loads its data once. */}
                {opened.has('rankings') || opened.has('news') ? (
                    <RetainedPanel active={focused && (section === 'rankings' || section === 'news')}>
                        <DynastyHub section={section === 'news' || (section === 'players' && lastDynasty === 'news') ? 'news' : 'rankings'} />
                    </RetainedPanel>
                ) : null}
            </View>
        </Page>
    )
}

const localStyles = StyleSheet.create({
    freshness: { minHeight: controlSize.minTouch, justifyContent: 'center', paddingVertical: spacing.sm },
    freshnessText: { ...typeScale.small, color: colors.textSecondary },
    panel: { flex: 1, minHeight: 0 },
    results: { flex: 1, minHeight: 320 },
    pageProgress: { minHeight: controlSize.minTouch, alignItems: 'center', justifyContent: 'center' },
    toolbar: {
        gap: spacing.xs,
        paddingVertical: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    toolbarRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: spacing.sm,
    },
    searchWide: { flexGrow: 0, flexBasis: 280, minWidth: 220, height: controlSize.minTouch },
    filterButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        minHeight: controlSize.minTouch,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    filterButtonActive: { backgroundColor: colors.primaryLight, borderColor: colors.primaryBorder },
    filterButtonText: { ...typeScale.small, fontWeight: fontWeight.bold, color: colors.textSecondary },
    filterButtonTextActive: { color: colors.primaryDark },
    clearButton: { minHeight: controlSize.minTouch, justifyContent: 'center', paddingHorizontal: spacing.md },
    clearButtonText: { ...typeScale.small, fontWeight: fontWeight.bold, color: colors.dangerDark },
    summary: { ...textStyles.meta },
    summaryWide: { marginLeft: 'auto', flexShrink: 0 },
    sheetFields: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
    sheetActions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl },
    sortDirInSheet: { flexGrow: 1, flexBasis: 140, minHeight: controlSize.minTouch },
    sheetClear: {
        minHeight: controlSize.minTouch,
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.borderLight,
    },
    sheetDone: {
        flex: 1,
        minHeight: controlSize.minTouch,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        backgroundColor: colors.primary,
    },
    sheetDoneText: { ...typeScale.row, fontWeight: fontWeight.bold, color: colors.textWhite },
    addLimitNotice: {
        ...typeScale.caption,
        marginTop: spacing.xs,
        fontWeight: fontWeight.semibold,
        color: colors.warningDark,
    },
})

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

export default function PlayersScreenWithStatus() {
    return <ScreenStatusProvider><PlayersScreen /></ScreenStatusProvider>
}
