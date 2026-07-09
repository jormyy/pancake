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
    const requestIds = useRef(new Map<LeagueTab, number>())
    const activeTabRef = useRef(activeTab)
    const activeLeagueIdRef = useRef(leagueId)
    activeTabRef.current = activeTab
    activeLeagueIdRef.current = leagueId

    useEffect(() => {
        loadedTabs.current.clear()
        requestIds.current.clear()
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
    }, [leagueId])

    const fetchTab = useCallback(async (nextTab: LeagueTab, lid: string) => {
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
            if (activeLeagueIdRef.current !== lid || requestIds.current.get(nextTab) !== requestId) return
            commit()
            loadedTabs.current.add(nextTab)
        } catch (error) {
            if (activeLeagueIdRef.current === lid && requestIds.current.get(nextTab) === requestId) {
                setTabError((prev) => ({
                    ...prev,
                    [nextTab]: error instanceof Error ? error.message : 'Unknown error',
                }))
            }
        } finally {
            if (activeLeagueIdRef.current === lid && requestIds.current.get(nextTab) === requestId) {
                setTabLoading((prev) => ({ ...prev, [nextTab]: false }))
            }
        }
    }, [memberId])

    const ensureTab = useCallback((nextTab: LeagueTab) => {
        if (leagueId && !loadedTabs.current.has(nextTab)) void fetchTab(nextTab, leagueId)
    }, [fetchTab, leagueId])

    const invalidateTab = useCallback((nextTab: LeagueTab) => {
        loadedTabs.current.delete(nextTab)
        if (activeTabRef.current === nextTab) ensureTab(nextTab)
    }, [ensureTab])

    useFocusEffect(useCallback(() => {
        ensureTab(activeTab)
    }, [activeTab, ensureTab]))

    const loadMoreActivity = useCallback(async () => {
        if (!leagueId || activityLoadingMore) return
        setActivityLoadingMore(true)
        try {
            const nextOffset = activityOffset + ACTIVITY_LIMIT
            const data = await getLeagueTransactions(leagueId, ACTIVITY_LIMIT, nextOffset)
            setTransactions((prev) => [...prev, ...data])
            setActivityOffset(nextOffset)
            setActivityHasMore(data.length === ACTIVITY_LIMIT)
            setActivityLoadMoreError(null)
        } catch (error) {
            setActivityLoadMoreError(error instanceof Error ? error.message : 'Could not load more activity')
        } finally {
            setActivityLoadingMore(false)
        }
    }, [activityLoadingMore, activityOffset, leagueId])

    const refreshMockRooms = useCallback(async () => {
        if (!leagueId || !memberId) return
        await fetchTab('mockRooms', leagueId)
    }, [fetchTab, leagueId, memberId])

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
        refreshMockRooms,
        standings,
        tabError: tabError[activeTab],
        transactions,
        waiverOrder,
    }
}
