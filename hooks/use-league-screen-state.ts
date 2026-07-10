import { Share } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { parseLeagueTab, type LeagueTab } from '@/lib/league/tabs'
import {
    debounceRealtimeRefresh,
    disposeTableChangeSubscription,
    reportRealtimeCleanup,
    subscribeToTableChanges,
    type TableChangeWatch,
} from '@/lib/realtime'
import { leagueScreenWatches } from '@/lib/league/realtime'
import { useLeagueTabResources } from '@/hooks/use-league-tab-resources'
import { useLeagueDraftController } from '@/hooks/use-league-draft-controller'
import { useMockRoomsController } from '@/hooks/use-mock-rooms-controller'

export function useLeagueScreenState() {
    const router = useRouter()
    const { push } = router
    const params = useLocalSearchParams<{ tab?: string }>()
    const { current, currentLeague, isCommissioner, loading: leagueLoading } = useLeagueContext()
    const [tab, setTab] = useState<LeagueTab>(() => parseLeagueTab(params.tab))
    const [sharing, setSharing] = useState(false)
    const tabResources = useLeagueTabResources(currentLeague?.id, current?.id, tab)
    const draft = useLeagueDraftController(currentLeague?.id)
    const mockRooms = useMockRoomsController({
        leagueId: currentLeague?.id,
        memberId: current?.id,
        nominationMode: draft.nominationMode,
        draftTimerSeconds: draft.draftTimerSeconds,
        rookieRounds: draft.rookieRounds,
        rookieTimerExpiryBehavior: draft.rookieTimerExpiryBehavior,
        refreshRooms: tabResources.refreshMockRooms,
        openDraftRoom: draft.openDraftRoom,
    })
    const { invalidateTab } = tabResources
    const { fetchActiveDraft } = draft

    useEffect(() => {
        setTab(parseLeagueTab(params.tab))
    }, [params.tab])

    const currentDraftKey = useMemo(() => [...new Set([
        draft.activeDraft?.id,
        ...tabResources.mockRooms.map((room) => room.id),
    ].filter((id): id is string => Boolean(id)))].sort().join(','), [draft.activeDraft?.id, tabResources.mockRooms])

    useEffect(() => {
        const lid = currentLeague?.id
        if (!lid) return
        const refreshResults = debounceRealtimeRefresh(() => { invalidateTab('results') })
        const refreshHistory = debounceRealtimeRefresh(() => { invalidateTab('history') })
        const refreshSettings = debounceRealtimeRefresh(() => { invalidateTab('settings') })
        const refreshDraftBoard = debounceRealtimeRefresh(() => { invalidateTab('draftBoard') })
        const refreshMockRooms = debounceRealtimeRefresh(() => { invalidateTab('mockRooms') })
        const refreshDraftState = debounceRealtimeRefresh(() => { void fetchActiveDraft(lid) })
        const leagueWatches = leagueScreenWatches(lid, {
            members: () => {
                refreshResults.trigger()
                refreshMockRooms.trigger()
            },
            history: refreshHistory.trigger,
            settings: refreshSettings.trigger,
            draftBoard: refreshDraftBoard.trigger,
            drafts: () => {
                refreshDraftState.trigger()
                refreshMockRooms.trigger()
            },
        })
        const draftFilter = currentDraftKey ? `draft_id=in.(${currentDraftKey})` : null
        const draftWatches: TableChangeWatch[] = draftFilter ? [
            { table: 'draft_room_members', filter: draftFilter, onChange: () => {
                refreshDraftState.trigger()
                refreshMockRooms.trigger()
            } },
            { table: 'snake_draft_picks', filter: draftFilter, onChange: () => {
                refreshDraftBoard.trigger()
                refreshDraftState.trigger()
            } },
        ] : []
        const channel = subscribeToTableChanges(`league-screen:${lid}:${currentDraftKey || 'none'}`, {
            mode: 'per-watch',
            watches: [...leagueWatches, ...draftWatches],
        })
        return () => reportRealtimeCleanup(
            'league screen',
            disposeTableChangeSubscription(channel, [
                refreshResults,
                refreshHistory,
                refreshSettings,
                refreshDraftBoard,
                refreshMockRooms,
                refreshDraftState,
            ]),
        )
    }, [currentDraftKey, currentLeague?.id, fetchActiveDraft, invalidateTab])

    const handleTabChange = (nextTab: LeagueTab) => {
        setTab(nextTab)
        router.push(`/league?tab=${nextTab}`)
    }

    const shareInviteCode = useCallback(async () => {
        if (sharing) return
        setSharing(true)
        try {
            await Share.share({
                message: `Join my Pancake league! Use invite code: ${currentLeague?.invite_code}`,
            })
        } finally {
            setSharing(false)
        }
    }, [currentLeague?.invite_code, sharing])

    return {
        activeDraft: draft.activeDraft,
        activeDraftError: draft.activeDraftError,
        activeDraftLoading: draft.activeDraftLoading,
        activeDraftLoaded: draft.activeDraftLoaded,
        activityHasMore: tabResources.activityHasMore,
        activityLoadMoreError: tabResources.activityLoadMoreError,
        activityLoadingMore: tabResources.activityLoadingMore,
        current,
        currentLeague,
        currentLeaguePicks: tabResources.currentLeaguePicks,
        draftLoading: draft.draftLoading || mockRooms.roomActionLoading,
        draftTimerSeconds: draft.draftTimerSeconds,
        handleCreateMockRoom: mockRooms.handleCreateMockRoom,
        handleJoinDraftRoom: draft.handleJoinDraftRoom,
        handleJoinMockRoom: mockRooms.handleJoinMockRoom,
        handleLeaveMockRoom: mockRooms.handleLeaveMockRoom,
        handleLoadMoreActivity: tabResources.loadMoreActivity,
        handleReseedRookiePicks: draft.handleReseedRookiePicks,
        handleStartDraft: draft.handleStartDraft,
        handleStartMockRoom: mockRooms.handleStartMockRoom,
        handleStartRookieDraft: draft.handleStartRookieDraft,
        handleTabChange,
        isCommissioner,
        leagueLoading,
        isTabLoading: tabResources.isTabLoading,
        isTabLoaded: tabResources.isTabLoaded,
        mockRooms: tabResources.mockRooms,
        nominationMode: draft.nominationMode,
        openBracket: () => push('/(modals)/bracket'),
        openCommissionerSettings: () => push('/(modals)/commissioner-settings'),
        openDraftRoom: draft.openDraftRoom,
        openTeamRoster: (memberId: string, teamName: string) =>
            push({ pathname: '/(modals)/team-roster', params: { memberId, teamName } }),
        retryActiveDraft: draft.retryActiveDraft,
        retryCurrentTab: () => currentLeague?.id && tabResources.refreshTab(tab),
        rookieRounds: draft.rookieRounds,
        rookieTimerExpiryBehavior: draft.rookieTimerExpiryBehavior,
        roomDraftType: mockRooms.roomDraftType,
        roomName: mockRooms.roomName,
        roomScheduledAt: mockRooms.roomScheduledAt,
        roomSubmitting: mockRooms.roomSubmitting,
        setDraftTimerSeconds: draft.setDraftTimerSeconds,
        setNominationMode: draft.setNominationMode,
        setRookieRounds: draft.setRookieRounds,
        setRookieTimerExpiryBehavior: draft.setRookieTimerExpiryBehavior,
        setRoomDraftType: mockRooms.setRoomDraftType,
        setRoomName: mockRooms.setRoomName,
        setRoomScheduledAt: mockRooms.setRoomScheduledAt,
        shareInviteCode,
        standings: tabResources.standings,
        tab,
        tabErr: tabResources.tabError,
        transactions: tabResources.transactions,
        waiverOrder: tabResources.waiverOrder,
    }
}
