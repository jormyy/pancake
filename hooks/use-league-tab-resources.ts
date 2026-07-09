import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { getLeagueStandings, type StandingRow } from '@/lib/scoring'
import { getWaiverPriorityOrder, type WaiverPriorityRow } from '@/lib/waivers'
import { getLeagueTransactions, type TransactionRow } from '@/lib/transactions'
import { getAllLeaguePicks, type LeaguePickItem } from '@/lib/rookieDraft'
import { getMockDraftRooms, type MockDraftRoom } from '@/lib/mockDraftRooms'
import type { LeagueTab } from '@/lib/league/tabs'

const ACTIVITY_LIMIT = 50

export function useLeagueTabResources(
    leagueId: string | undefined,
    memberId: string | undefined,
    activeTab: LeagueTab,
) {
    const [standings, setStandings] = useState<StandingRow[]>([])
    const [transactions, setTransactions] = useState<TransactionRow[]>([])
    const [waiverOrder, setWaiverOrder] = useState<WaiverPriorityRow[]>([])
    const [currentLeaguePicks, setCurrentLeaguePicks] = useState<LeaguePickItem[]>([])
    const [mockRooms, setMockRooms] = useState<MockDraftRoom[]>([])
    const [activityOffset, setActivityOffset] = useState(0)
    const [activityHasMore, setActivityHasMore] = useState(false)
    const [activityLoadingMore, setActivityLoadingMore] = useState(false)
    const [activityLoadMoreError, setActivityLoadMoreError] = useState<string | null>(null)
    const [tabLoading, setTabLoading] = useState<Partial<Record<LeagueTab, boolean>>>({ results: true })
    const [tabError, setTabError] = useState<Partial<Record<LeagueTab, string>>>({})
    const loadedTabs = useRef<Set<LeagueTab>>(new Set())
    const inFlightTabs = useRef(new Map<LeagueTab, { leagueId: string; promise: Promise<void> }>())
    const invalidatedInFlightTabs = useRef(new Set<LeagueTab>())
    const requestIds = useRef(new Map<LeagueTab, number>())
    const activityRequest = useRef<{ leagueId: string; requestId: number } | null>(null)
    const nextActivityRequestId = useRef(0)
    const activeTabRef = useRef(activeTab)
    const activeLeagueIdRef = useRef(leagueId)
    const activeMemberIdRef = useRef(memberId)
    activeTabRef.current = activeTab
    activeLeagueIdRef.current = leagueId
    activeMemberIdRef.current = memberId

    useEffect(() => {
        loadedTabs.current.clear()
        inFlightTabs.current.clear()
        invalidatedInFlightTabs.current.clear()
        requestIds.current.clear()
        activityRequest.current = null
        nextActivityRequestId.current += 1
        setStandings([])
        setTransactions([])
        setWaiverOrder([])
        setCurrentLeaguePicks([])
        setMockRooms([])
        setActivityOffset(0)
        setActivityHasMore(false)
        setActivityLoadingMore(false)
        setActivityLoadMoreError(null)
        setTabError({})
        setTabLoading({ results: true })
    }, [leagueId, memberId])

    const runTabFetch = useCallback(async (nextTab: LeagueTab, lid: string) => {
        const requestedMemberId = memberId
        const requestId = (requestIds.current.get(nextTab) ?? 0) + 1
        requestIds.current.set(nextTab, requestId)
        setTabLoading((prev) => ({ ...prev, [nextTab]: true }))
        setTabError((prev) => {
            const next = { ...prev }
            delete next[nextTab]
            return next
        })
        try {
            let commit: () => void = () => {}
            if (nextTab === 'results') {
                const data = await getLeagueStandings(lid)
                commit = () => setStandings(data)
            } else if (nextTab === 'history') {
                const data = await getLeagueTransactions(lid, ACTIVITY_LIMIT, 0)
                commit = () => {
                    setTransactions(data)
                    setActivityOffset(0)
                    setActivityHasMore(data.length === ACTIVITY_LIMIT)
                }
            } else if (nextTab === 'settings') {
                const data = await getWaiverPriorityOrder(lid)
                commit = () => setWaiverOrder(data)
            } else if (nextTab === 'draftBoard') {
                const data = await getAllLeaguePicks(lid)
                commit = () => setCurrentLeaguePicks(data)
            } else if (nextTab === 'mockRooms' && memberId) {
                const data = await getMockDraftRooms(lid, memberId)
                commit = () => setMockRooms(data)
            }
            if (activeLeagueIdRef.current !== lid || activeMemberIdRef.current !== requestedMemberId || requestIds.current.get(nextTab) !== requestId) return
            commit()
            loadedTabs.current.add(nextTab)
        } catch (error) {
            if (activeLeagueIdRef.current === lid && activeMemberIdRef.current === requestedMemberId && requestIds.current.get(nextTab) === requestId) {
                setTabError((prev) => ({
                    ...prev,
                    [nextTab]: error instanceof Error ? error.message : 'Unknown error',
                }))
            }
        } finally {
            if (activeLeagueIdRef.current === lid && activeMemberIdRef.current === requestedMemberId && requestIds.current.get(nextTab) === requestId) {
                setTabLoading((prev) => ({ ...prev, [nextTab]: false }))
            }
        }
    }, [memberId])

    const fetchTab = useCallback((nextTab: LeagueTab, lid: string): Promise<void> => {
        const existing = inFlightTabs.current.get(nextTab)
        if (existing?.leagueId === lid) return existing.promise

        const request = { leagueId: lid, promise: Promise.resolve() }
        request.promise = runTabFetch(nextTab, lid).finally(async () => {
            if (inFlightTabs.current.get(nextTab) !== request) return
            inFlightTabs.current.delete(nextTab)
            if (!invalidatedInFlightTabs.current.delete(nextTab)) return
            loadedTabs.current.delete(nextTab)
            if (activeLeagueIdRef.current === lid) await fetchTab(nextTab, lid)
        })
        inFlightTabs.current.set(nextTab, request)
        return request.promise
    }, [runTabFetch])

    const ensureTab = useCallback((nextTab: LeagueTab) => {
        if (leagueId && !loadedTabs.current.has(nextTab)) void fetchTab(nextTab, leagueId)
    }, [fetchTab, leagueId])

    const invalidateTab = useCallback((nextTab: LeagueTab) => {
        loadedTabs.current.delete(nextTab)
        if (inFlightTabs.current.has(nextTab)) {
            invalidatedInFlightTabs.current.add(nextTab)
            return
        }
        if (activeTabRef.current === nextTab) ensureTab(nextTab)
    }, [ensureTab])

    const refreshTab = useCallback((nextTab: LeagueTab): Promise<void> => {
        if (!leagueId) return Promise.resolve()
        loadedTabs.current.delete(nextTab)
        const existing = inFlightTabs.current.get(nextTab)
        if (existing?.leagueId === leagueId) {
            invalidatedInFlightTabs.current.add(nextTab)
            return existing.promise
        }
        return fetchTab(nextTab, leagueId)
    }, [fetchTab, leagueId])

    useFocusEffect(useCallback(() => {
        ensureTab(activeTab)
    }, [activeTab, ensureTab]))

    const loadMoreActivity = useCallback(async () => {
        if (!leagueId || activityRequest.current) return
        const request = { leagueId, requestId: ++nextActivityRequestId.current }
        activityRequest.current = request
        setActivityLoadingMore(true)
        try {
            const nextOffset = activityOffset + ACTIVITY_LIMIT
            const data = await getLeagueTransactions(leagueId, ACTIVITY_LIMIT, nextOffset)
            if (activeLeagueIdRef.current !== leagueId || activityRequest.current !== request) return
            setTransactions((prev) => [...prev, ...data])
            setActivityOffset(nextOffset)
            setActivityHasMore(data.length === ACTIVITY_LIMIT)
            setActivityLoadMoreError(null)
        } catch (error) {
            if (activeLeagueIdRef.current === leagueId && activityRequest.current === request) {
                setActivityLoadMoreError(error instanceof Error ? error.message : 'Could not load more activity')
            }
        } finally {
            if (activityRequest.current === request) {
                activityRequest.current = null
                if (activeLeagueIdRef.current === leagueId) setActivityLoadingMore(false)
            }
        }
    }, [activityOffset, leagueId])

    const refreshMockRooms = useCallback(async () => {
        if (!leagueId || !memberId) return
        await refreshTab('mockRooms')
    }, [leagueId, memberId, refreshTab])

    return {
        activityHasMore,
        activityLoadMoreError,
        activityLoadingMore,
        currentLeaguePicks,
        ensureTab,
        fetchTab,
        invalidateTab,
        isTabLoading: tabLoading[activeTab] === true,
        loadMoreActivity,
        mockRooms,
        refreshTab,
        refreshMockRooms,
        standings,
        tabError: tabError[activeTab],
        transactions,
        waiverOrder,
    }
}
