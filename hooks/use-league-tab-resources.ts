import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { getLeagueStandings, type StandingRow } from '@/lib/scoring'
import { getWaiverPriorityOrder, type WaiverPriorityRow } from '@/lib/waivers'
import { getLeagueTransactions, type TransactionRow } from '@/lib/transactions'
import { getAllLeaguePicks, type LeaguePickItem } from '@/lib/rookieDraft'
import { getMockDraftRooms, type MockDraftRoom } from '@/lib/mockDraftRooms'
import type { LeagueTab } from '@/lib/league/tabs'
import { useKeyedResource } from '@/hooks/use-keyed-resource'

const ACTIVITY_LIMIT = 50
const EMPTY_STANDINGS: StandingRow[] = []
const EMPTY_TRANSACTIONS: TransactionRow[] = []
const EMPTY_WAIVER_ORDER: WaiverPriorityRow[] = []
const EMPTY_PICKS: LeaguePickItem[] = []
const EMPTY_MOCK_ROOMS: MockDraftRoom[] = []

export function useLeagueTabResources(
    leagueId: string | undefined,
    memberId: string | undefined,
    activeTab: LeagueTab,
) {
    const leagueKey = leagueId ?? null
    const memberKey = leagueId && memberId ? `${leagueId}:${memberId}` : null
    const standings = useKeyedResource(
        leagueKey,
        EMPTY_STANDINGS,
        useCallback(() => leagueId ? getLeagueStandings(leagueId) : Promise.resolve([]), [leagueId]),
    )
    const history = useKeyedResource(
        leagueKey,
        EMPTY_TRANSACTIONS,
        useCallback(() => leagueId ? getLeagueTransactions(leagueId, ACTIVITY_LIMIT, 0) : Promise.resolve([]), [leagueId]),
    )
    const waiverOrder = useKeyedResource(
        leagueKey,
        EMPTY_WAIVER_ORDER,
        useCallback(() => leagueId ? getWaiverPriorityOrder(leagueId) : Promise.resolve([]), [leagueId]),
    )
    const picks = useKeyedResource(
        leagueKey,
        EMPTY_PICKS,
        useCallback(() => leagueId ? getAllLeaguePicks(leagueId) : Promise.resolve([]), [leagueId]),
    )
    const mockRooms = useKeyedResource(
        memberKey,
        EMPTY_MOCK_ROOMS,
        useCallback(() => leagueId && memberId ? getMockDraftRooms(leagueId, memberId) : Promise.resolve([]), [leagueId, memberId]),
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
    const activeResource = activeTab === 'auctions' ? null : resources[activeTab]
    const activeResourceKey = activeTab === 'auctions'
        ? null
        : activeTab === 'mockRooms' ? memberKey : leagueKey
    const [activityOffset, setActivityOffset] = useState(0)
    const [activityHasMore, setActivityHasMore] = useState(false)
    const [activityLoadingMore, setActivityLoadingMore] = useState(false)
    const [activityLoadMoreError, setActivityLoadMoreError] = useState<string | null>(null)
    const activityRequest = useRef<symbol | null>(null)
    const activeTabRef = useRef(activeTab)
    activeTabRef.current = activeTab

    const resetActivityPagination = useCallback(() => {
        activityRequest.current = null
        setActivityOffset(0)
        setActivityHasMore(false)
        setActivityLoadingMore(false)
        setActivityLoadMoreError(null)
    }, [])

    useEffect(() => {
        resetActivityPagination()
    }, [leagueKey, resetActivityPagination])

    useEffect(() => {
        if (activityOffset === 0) setActivityHasMore(history.data.length === ACTIVITY_LIMIT)
    }, [activityOffset, history.data.length])

    const ensureTab = useCallback((tab: LeagueTab) => {
        if (tab !== 'auctions') void resourcesRef.current[tab].ensure()
    }, [])
    const invalidateTab = useCallback((tab: LeagueTab) => {
        if (tab === 'history') resetActivityPagination()
        if (tab !== 'auctions') resourcesRef.current[tab].invalidate(activeTabRef.current === tab)
    }, [resetActivityPagination])
    const refreshTab = useCallback((tab: LeagueTab) => {
        if (tab === 'history') resetActivityPagination()
        return tab === 'auctions' ? Promise.resolve() : resourcesRef.current[tab].refresh()
    }, [resetActivityPagination])

    useFocusEffect(useCallback(() => {
        if (activeResourceKey) ensureTab(activeTab)
    }, [activeResourceKey, activeTab, ensureTab]))

    const loadMoreActivity = useCallback(async () => {
        if (!leagueId || activityRequest.current) return
        const request = Symbol('activity')
        activityRequest.current = request
        setActivityLoadingMore(true)
        try {
            const nextOffset = activityOffset + ACTIVITY_LIMIT
            const data = await getLeagueTransactions(leagueId, ACTIVITY_LIMIT, nextOffset)
            if (activityRequest.current !== request) return
            resourcesRef.current.history.setData((current) => [...current, ...data])
            setActivityOffset(nextOffset)
            setActivityHasMore(data.length === ACTIVITY_LIMIT)
            setActivityLoadMoreError(null)
        } catch (error) {
            if (activityRequest.current === request) {
                setActivityLoadMoreError(error instanceof Error ? error.message : 'Could not load more activity')
            }
        } finally {
            if (activityRequest.current === request) {
                activityRequest.current = null
                setActivityLoadingMore(false)
            }
        }
    }, [activityOffset, leagueId])

    return {
        activityHasMore,
        activityLoadMoreError,
        activityLoadingMore,
        currentLeaguePicks: picks.data,
        ensureTab,
        invalidateTab,
        // "Loading" means the first load for this tab — background refreshes
        // keep existing content on screen instead of flashing loading UI.
        isTabLoading: activeResource ? activeResource.loading && !activeResource.loaded : false,
        isTabLoaded: activeResource ? activeResource.loaded : true,
        loadMoreActivity,
        mockRooms: mockRooms.data,
        refreshTab,
        refreshMockRooms: mockRooms.refresh,
        standings: standings.data,
        tabError: activeResource?.error ?? undefined,
        transactions: history.data,
        waiverOrder: waiverOrder.data,
    }
}
