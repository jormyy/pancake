import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { parseLeagueTab, type LeagueSection } from '@/lib/league/tabs'


import { useLeagueTabResources } from '@/hooks/use-league-tab-resources'
import { useLeagueDraftController } from '@/hooks/use-league-draft-controller'
import { useMockRoomsController } from '@/hooks/use-mock-rooms-controller'
import { shareInviteMessage } from '@/lib/invite-share'

export function useLeagueScreenState() {
    const router = useRouter()
    const { push } = router
    const params = useLocalSearchParams<{ tab?: string }>()
    const { current, currentLeague, isCommissioner, loading: leagueLoading, membershipValidated } = useLeagueContext()
    const [tab, setTab] = useState<LeagueSection>(() => parseLeagueTab(params.tab))
    const [sharing, setSharing] = useState(false)
    const tabResources = useLeagueTabResources(currentLeague?.id, current?.id, tab, membershipValidated)
    const draft = useLeagueDraftController(currentLeague?.id, { memberId: current?.id, authorized: membershipValidated, view: useMemo(() => ({ draft: tabResources.activeDraft, loaded: tabResources.activeDraftLoaded, error: tabResources.activeDraftError }), [tabResources.activeDraft, tabResources.activeDraftLoaded, tabResources.activeDraftError]) })
    const mockRooms = useMockRoomsController({
        leagueId: currentLeague?.id,
        memberId: current?.id,
        refreshRooms: tabResources.refreshMockRooms,
        openDraftRoom: draft.openDraftRoom,
    })
    useEffect(() => { setTab(parseLeagueTab(params.tab)) }, [params.tab])

    const handleTabChange = (nextTab: LeagueSection) => {
        setTab(nextTab)
        // setParams (not push) keeps the current screen instance mounted, so the
        // pill tab bar keeps its scroll position instead of resetting to the start.
        router.setParams({ tab: nextTab })
    }

    const shareInviteCode = useCallback(async () => {
        if (sharing) return
        setSharing(true)
        try {
            await shareInviteMessage(`Join my Pancake league! Use invite code: ${currentLeague?.invite_code}`)
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
        handleDeleteMockRoom: mockRooms.handleDeleteMockRoom,
        handleStartMockRoom: mockRooms.handleStartMockRoom,
        handleStartRookieDraft: draft.handleStartRookieDraft,
        handleTabChange,
        isCommissioner,
        leagueLoading,
        isTabLoading: tabResources.isTabLoading,
        isTabLoaded: tabResources.isTabLoaded,
        isTabRefreshing: tabResources.isTabRefreshing,
        isOnline: tabResources.isOnline,
        mockRooms: tabResources.mockRooms,
        nominationMode: draft.nominationMode,
        openBracket: () => push('/(modals)/bracket'),
        openCommissionerSettings: () => push('/(modals)/commissioner-settings'),
        openDraftRoom: draft.openDraftRoom,
        openTeamRoster: (memberId: string, teamName: string) =>
            push({ pathname: '/(modals)/team-roster', params: { memberId, teamName } }),
        retryActiveDraft: draft.retryActiveDraft,
        retryCurrentTab: () => currentLeague?.id ? tabResources.refreshTab(tab) : Promise.resolve(),
        rookieRounds: draft.rookieRounds,
        rookieTimerExpiryBehavior: draft.rookieTimerExpiryBehavior,
        mockNominationMode: mockRooms.mockNominationMode,
        setMockNominationMode: mockRooms.setMockNominationMode,
        mockDraftTimerSeconds: mockRooms.mockDraftTimerSeconds,
        setMockDraftTimerSeconds: mockRooms.setMockDraftTimerSeconds,
        mockRookieRounds: mockRooms.mockRookieRounds,
        setMockRookieRounds: mockRooms.setMockRookieRounds,
        mockRookieTimerExpiryBehavior: mockRooms.mockRookieTimerExpiryBehavior,
        setMockRookieTimerExpiryBehavior: mockRooms.setMockRookieTimerExpiryBehavior,
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
