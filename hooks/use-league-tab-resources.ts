import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { getLeagueStandings, type StandingRow } from '@/lib/scoring'
import { getWaiverPriorityOrder, type WaiverPriorityRow } from '@/lib/waivers'
import { getLeagueTransactions, type TransactionRow } from '@/lib/transactions'
import { getAllLeaguePicks, type LeaguePickItem } from '@/lib/rookieDraft'
import { getMockDraftRooms, type MockDraftRoom } from '@/lib/mockDraftRooms'
import type { LeagueTab } from '@/lib/league/tabs'
import { useKeyedResource } from '@/hooks/use-keyed-resource'
import { useBrowserReadActivity, browserReadsAllowed } from '@/hooks/use-browser-read-activity'
import { sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'

const ACTIVITY_LIMIT = 50
const EMPTY_STANDINGS: StandingRow[] = []
type ActivityPage = { rows: TransactionRow[]; hasMore: boolean }
const EMPTY_ACTIVITY: ActivityPage = { rows: [], hasMore: false }
const EMPTY_WAIVER_ORDER: WaiverPriorityRow[] = []
const EMPTY_PICKS: LeaguePickItem[] = []
const EMPTY_MOCK_ROOMS: MockDraftRoom[] = []
type ResourceTab = 'results' | 'history' | 'settings' | 'draftBoard' | 'mockRooms'

function resourceTab(tab: LeagueTab): ResourceTab | null {
    if (tab === 'picks') return 'draftBoard'
    if (tab === 'draft') return 'mockRooms'
    return tab === 'auctions' ? null : tab
}

const RESOURCE_TABS: ResourceTab[] = ['results', 'history', 'settings', 'draftBoard', 'mockRooms']

// Persistent per-tab cache: revisits render cached content instantly (no
// blank flash) while the fresh fetch updates it in place.
const LEAGUE_TAB_CACHE_PREFIX = 'pancake:league-tab:v1:'
function tabCache<Value>(tab: LeagueTab) {
    return {
        read: (key: string) => readPersistentCache<Value>(`${LEAGUE_TAB_CACHE_PREFIX}${tab}:${key}`) ?? undefined,
        write: (key: string, value: Value) => writePersistentCache(`${LEAGUE_TAB_CACHE_PREFIX}${tab}:${key}`, value),
    }
}
const STANDINGS_CACHE = tabCache<StandingRow[]>('results')
const HISTORY_ROWS_CACHE = tabCache<TransactionRow[]>('history')
const HISTORY_CACHE = {
    read: (key: string): ActivityPage | undefined => {
        const rows = HISTORY_ROWS_CACHE.read(key)
        return rows ? { rows, hasMore: rows.length > 0 && rows.length % ACTIVITY_LIMIT === 0 } : undefined
    },
    write: (key: string, page: ActivityPage) => HISTORY_ROWS_CACHE.write(key, page.rows),
}
const WAIVER_ORDER_CACHE = tabCache<WaiverPriorityRow[]>('settings')
const PICKS_CACHE = tabCache<LeaguePickItem[]>('draftBoard')
const MOCK_ROOMS_CACHE = tabCache<MockDraftRoom[]>('mockRooms')

export function useLeagueTabResources(
    leagueId: string | undefined,
    memberId: string | undefined,
    activeTab: LeagueTab,
    authorized = true,
) {
    const isOnline = useOnlineStatus()
    const activity = useBrowserReadActivity()
    const wasOnline = useRef(isOnline)
    const focused = useRef(false)
    const generation = sessionGeneration()
    const leagueKey = leagueId && memberId ? JSON.stringify([sessionOwner(), generation, leagueId, memberId]) : null
    const admission = () => focused.current && isOnline && authorized && sessionOwner() !== null
        && sessionGeneration() === generation && activity.isCurrent(activity.revision)
    const admissionRef = useRef(admission)
    admissionRef.current = admission
    const activeLeagueRef = useRef(leagueKey)
    activeLeagueRef.current = leagueKey
    const memberKey = leagueId && memberId ? leagueKey : null
    const standings = useKeyedResource(
        leagueKey,
        EMPTY_STANDINGS,
        useCallback(() => leagueId ? getLeagueStandings(leagueId, admissionRef.current) : Promise.resolve([]), [leagueId]),
        STANDINGS_CACHE,
        admission,
    )
    const history = useKeyedResource(
        leagueKey,
        EMPTY_ACTIVITY,
        useCallback(async () => {
            const rows = leagueId ? await getLeagueTransactions(leagueId, ACTIVITY_LIMIT, 0) : []
            return { rows, hasMore: rows.length === ACTIVITY_LIMIT }
        }, [leagueId]),
        HISTORY_CACHE,
        admission,
    )
    const waiverOrder = useKeyedResource(
        leagueKey,
        EMPTY_WAIVER_ORDER,
        useCallback(() => leagueId ? getWaiverPriorityOrder(leagueId, admissionRef.current) : Promise.resolve([]), [leagueId]),
        WAIVER_ORDER_CACHE,
        admission,
    )
    const picks = useKeyedResource(
        leagueKey,
        EMPTY_PICKS,
        useCallback(() => leagueId ? getAllLeaguePicks(leagueId) : Promise.resolve([]), [leagueId]),
        PICKS_CACHE,
        admission,
    )
    const mockRooms = useKeyedResource(
        memberKey,
        EMPTY_MOCK_ROOMS,
        useCallback(() => leagueId && memberId ? getMockDraftRooms(leagueId, memberId) : Promise.resolve([]), [leagueId, memberId]),
        MOCK_ROOMS_CACHE,
        admission,
    )
    const resources = useMemo(() => ({
        results: standings,
        history,
        settings: waiverOrder,
        draftBoard: picks,
        mockRooms,
    }), [history, mockRooms, picks, standings, waiverOrder])
    const resourcesRef = useRef(resources)
    resourcesRef.current = resources
    const activeResourceTab = resourceTab(activeTab)
    const activeResource = activeResourceTab ? resources[activeResourceTab] : null
    const activeResourceKey = activeResourceTab === 'mockRooms' ? memberKey : activeResourceTab ? leagueKey : null
    const [activityLoadingMore, setActivityLoadingMore] = useState(false)
    const [activityLoadMoreError, setActivityLoadMoreError] = useState<string | null>(null)
    const activityRequest = useRef<symbol | null>(null)
    const activeTabRef = useRef(activeTab)
    activeTabRef.current = activeTab

    const resetActivityPagination = useCallback(() => {
        activityRequest.current = null
        setActivityLoadingMore(false)
        setActivityLoadMoreError(null)
    }, [])

    useEffect(() => {
        resetActivityPagination()
    }, [leagueKey, resetActivityPagination])

    const suspendActivityPagination = useCallback(() => {
        activityRequest.current = null
        setActivityLoadingMore(false)
    }, [])

    const ensureTab = useCallback((tab: LeagueTab) => {
        const target = resourceTab(tab)
        if (target && admissionRef.current()) void resourcesRef.current[target].ensure()
    }, [])
    const invalidateTab = useCallback((tab: LeagueTab) => {
        if (tab === 'history') resetActivityPagination()
        const target = resourceTab(tab)
        if (target) resourcesRef.current[target].invalidate(resourceTab(activeTabRef.current) === target && admissionRef.current())
    }, [resetActivityPagination])
    const refreshTab = useCallback((tab: LeagueTab) => {
        if (tab === 'history') resetActivityPagination()
        const target = resourceTab(tab)
        if (!target) return Promise.resolve()
        if (!admissionRef.current()) { resourcesRef.current[target].invalidate(false); return Promise.resolve() }
        return resourcesRef.current[target].refresh()
    }, [resetActivityPagination])

    useFocusEffect(useCallback(() => {
        focused.current = true
        return () => {
            focused.current = false
            for (const resource of Object.values(resourcesRef.current)) resource.suspend()
            suspendActivityPagination()
        }
    }, [suspendActivityPagination]))

    useEffect(() => {
        const reconnected = !wasOnline.current && isOnline
        wasOnline.current = isOnline
        if (!reconnected) return
        resetActivityPagination()
        for (const tab of RESOURCE_TABS) {
            resourcesRef.current[tab].invalidate(false)
        }
    }, [isOnline, resetActivityPagination])

    useEffect(() => {
        if (!admissionRef.current()) {
            for (const resource of Object.values(resourcesRef.current)) resource.suspend()
            suspendActivityPagination()
        } else if (activeResourceKey) ensureTab(activeTab)
    }, [activeResourceKey, activeTab, activity.revision, isOnline, authorized, ensureTab, suspendActivityPagination])

    useFocusEffect(useCallback(() => {
        if (activeResourceKey) ensureTab(activeTab)
    }, [activeResourceKey, activeTab, ensureTab]))

    const loadMoreActivity = useCallback(async () => {
        const resource = resourcesRef.current.history
        if (!admissionRef.current() || !browserReadsAllowed() || !leagueId || activeLeagueRef.current !== leagueKey || activityRequest.current || resource.loading || !resource.loaded || !resource.data.hasMore) return
        const permits = admissionRef.current
        const snapshot = resource.data
        const request = Symbol('activity')
        activityRequest.current = request
        setActivityLoadingMore(true)
        try {
            const data = await getLeagueTransactions(leagueId, ACTIVITY_LIMIT, snapshot.rows.length)
            if (activityRequest.current !== request || activeLeagueRef.current !== leagueKey || !permits()) return
            resource.setData((current) => current === snapshot
                ? { rows: [...current.rows, ...data], hasMore: data.length === ACTIVITY_LIMIT }
                : current)
            setActivityLoadMoreError(null)
        } catch (error) {
            if (activityRequest.current === request && permits()) {
                setActivityLoadMoreError(error instanceof Error ? error.message : 'Could not load more activity')
            }
        } finally {
            if (activityRequest.current === request) {
                activityRequest.current = null
                setActivityLoadingMore(false)
            }
        }
    }, [leagueId, leagueKey])

    const refreshMockRooms = useCallback(() => refreshTab('mockRooms'), [refreshTab])

    return {
        activityHasMore: history.data.hasMore,
        activityLoadMoreError,
        activityLoadingMore,
        currentLeaguePicks: picks.data,
        ensureTab,
        invalidateTab,
        // "Loading" means the first load for this tab — background refreshes
        // keep existing content on screen instead of flashing loading UI.
        isTabLoading: activeResource ? activeResource.loading && !activeResource.loaded : false,
        isTabLoaded: activeResource ? activeResource.loaded : true,
        isTabRefreshing: activeResource ? activeResource.loading && activeResource.loaded : false,
        isOnline,
        loadMoreActivity,
        mockRooms: mockRooms.data,
        refreshTab,
        refreshMockRooms,
        standings: standings.data,
        tabError: activeResource?.error ?? undefined,
        transactions: history.data.rows,
        waiverOrder: waiverOrder.data,
    }
}
