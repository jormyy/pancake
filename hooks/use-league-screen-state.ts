import { Share } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useLeagueContext } from '@/contexts/league-context'
import {
    getJoinableDraft,
    NOMINATION_ORDER_MODE_LABELS,
    ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS,
    startDraft,
    type Draft,
    type NominationOrderMode,
    type RookieTimerExpiryBehavior,
} from '@/lib/draft'
import {
    getActiveRookieDraft,
    startRookieDraft,
    reseedRookieDraftPicks,
} from '@/lib/rookieDraft'
import {
    createMockDraftRoom,
    joinMockDraftRoom,
    leaveMockDraftRoom,
    startMockDraftRoom,
    type MockDraftRoom,
    type MockDraftRoomKind,
} from '@/lib/mockDraftRooms'
import { confirmAction, showAlert } from '@/lib/alert'
import { parseLeagueTab, type LeagueTab } from '@/lib/league/tabs'
import {
    normalizeDraftTimerSeconds,
    type DraftTimerOption,
    type RookieRoundOption,
} from '@/components/league/DraftChips'
import {
    debounceRealtimeRefresh,
    disposeTableChangeSubscription,
    subscribeToTableChanges,
    type TableChangeWatch,
} from '@/lib/realtime'
import { leagueScreenWatches } from '@/lib/league/realtime'
import { useLeagueTabResources } from '@/hooks/use-league-tab-resources'

const OPEN_DRAFT_STATUSES = new Set(['pending', 'in_progress', 'paused'])

function defaultRoomDateInput(): string {
    const date = new Date(Date.now() + 30 * 60 * 1000)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function parseRoomDateInput(value: string): string | null {
    const normalized = value.trim().replace(' ', 'T')
    if (!normalized) return null
    const parsed = new Date(normalized)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function auctionDraftConfirmationMessage(draftTimerSeconds: DraftTimerOption, nominationMode: NominationOrderMode) {
    return `This will begin the auction draft for all teams with a ${draftTimerSeconds}-second timer and ${NOMINATION_ORDER_MODE_LABELS[nominationMode].toLowerCase()} nomination order. This cannot be undone.`
}

function rookieDraftConfirmationMessage(
    rookieRounds: RookieRoundOption,
    draftTimerSeconds: DraftTimerOption,
    rookieTimerExpiryBehavior: RookieTimerExpiryBehavior,
) {
    return `This will begin the rookie snake draft for ${rookieRounds} rounds with a ${draftTimerSeconds}-second timer and ${ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS[rookieTimerExpiryBehavior].toLowerCase()} timeout behavior. This cannot be undone.`
}

export function useLeagueScreenState() {
    const router = useRouter()
    const { push } = router
    const params = useLocalSearchParams<{ tab?: string }>()
    const { current, currentLeague, isCommissioner, loading: leagueLoading } = useLeagueContext()
    const [tab, setTab] = useState<LeagueTab>(() => parseLeagueTab(params.tab))
    const [draftLoading, setDraftLoading] = useState(false)
    const [nominationMode, setNominationMode] = useState<NominationOrderMode>('user_nominated')
    const [draftTimerSeconds, setDraftTimerSecondsState] = useState<DraftTimerOption>(30)
    const [rookieRounds, setRookieRounds] = useState<RookieRoundOption>(3)
    const [rookieTimerExpiryBehavior, setRookieTimerExpiryBehavior] =
        useState<RookieTimerExpiryBehavior>('auto_pick')
    const [activeDraft, setActiveDraft] = useState<Draft | null>(null)
    const [activeDraftLoading, setActiveDraftLoading] = useState(true)
    const [activeDraftError, setActiveDraftError] = useState<string | null>(null)
    const [roomName, setRoomName] = useState('')
    const [roomDraftType, setRoomDraftType] = useState<MockDraftRoomKind>('auction')
    const [roomScheduledAt, setRoomScheduledAt] = useState(defaultRoomDateInput)
    const [roomSubmitting, setRoomSubmitting] = useState(false)
    const [sharing, setSharing] = useState(false)

    const activeLeagueIdRef = useRef<string | undefined>(undefined)
    activeLeagueIdRef.current = currentLeague?.id
    const tabResources = useLeagueTabResources(currentLeague?.id, current?.id, tab)
    const { invalidateTab, mockRooms } = tabResources

    useEffect(() => {
        setTab(parseLeagueTab(params.tab))
    }, [params.tab])

    const setDraftTimerSeconds = useCallback((value: DraftTimerOption) => {
        setDraftTimerSecondsState(normalizeDraftTimerSeconds(value))
    }, [])

    useEffect(() => {
        setActiveDraft(null)
        setActiveDraftError(null)
        setActiveDraftLoading(Boolean(currentLeague?.id))
    }, [currentLeague?.id])

    const fetchActiveDraft = useCallback(async (lid: string) => {
        setActiveDraftLoading(true)
        try {
            const draft = await getJoinableDraft(lid, { includeCompletedRookie: true })
            if (activeLeagueIdRef.current !== lid) return
            setActiveDraft(draft)
            setActiveDraftError(null)
        } catch (e: unknown) {
            if (activeLeagueIdRef.current === lid) {
                setActiveDraft(null)
                setActiveDraftError(e instanceof Error ? e.message : 'Could not load active draft')
            }
        } finally {
            if (activeLeagueIdRef.current === lid) setActiveDraftLoading(false)
        }
    }, [])

    useFocusEffect(
        useCallback(() => {
            const lid = currentLeague?.id
            if (!lid) return
            void fetchActiveDraft(lid)
        }, [currentLeague?.id, fetchActiveDraft]),
    )

    const currentDraftKey = useMemo(() => [...new Set([
            activeDraft?.id,
            ...mockRooms.map((room) => room.id),
        ].filter((id): id is string => Boolean(id)))].sort().join(','), [activeDraft?.id, mockRooms])

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
        const currentDraftIds = currentDraftKey ? currentDraftKey.split(',') : []
        const draftFilter = currentDraftIds.length > 0 ? `draft_id=in.(${currentDraftKey})` : null
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

        return () => {
            disposeTableChangeSubscription(channel, [
                refreshResults,
                refreshHistory,
                refreshSettings,
                refreshDraftBoard,
                refreshMockRooms,
                refreshDraftState,
            ])
        }
    }, [currentDraftKey, currentLeague?.id, fetchActiveDraft, invalidateTab])

    function handleTabChange(nextTab: LeagueTab) {
        setTab(nextTab)
        router.push(`/league?tab=${nextTab}`)
        tabResources.ensureTab(nextTab)
    }

    async function handleStartDraft() {
        if (!currentLeague?.id) return
        confirmAction(
            'Start Auction Draft?',
            auctionDraftConfirmationMessage(draftTimerSeconds, nominationMode),
            async () => {
                setDraftLoading(true)
                try {
                    const draft = await startDraft(currentLeague.id, nominationMode, {
                        isMock: false,
                        timerSeconds: draftTimerSeconds,
                    })
                    push({ pathname: '/(modals)/draft-room', params: { draftId: draft.id } })
                } catch (e: unknown) {
                    showAlert('Could not start draft', e instanceof Error ? e.message : undefined)
                } finally {
                    setDraftLoading(false)
                }
            },
            'Start Auction',
        )
    }

    async function handleJoinDraftRoom() {
        if (!currentLeague?.id) return
        setDraftLoading(true)
        try {
            const draft = activeDraft ?? await getJoinableDraft(currentLeague.id, {
                includeCompletedRookie: true,
            })
            if (!draft) {
                showAlert('No active draft found')
                return
            }
            if (!OPEN_DRAFT_STATUSES.has(draft.status) && draft.status !== 'completed') {
                setActiveDraft(null)
                showAlert('No active draft found')
                return
            }
            openDraftRoom(draft.id, draft.draftType)
        } catch (e: unknown) {
            showAlert('Error', e instanceof Error ? e.message : undefined)
        } finally {
            setDraftLoading(false)
        }
    }

    async function handleStartRookieDraft() {
        if (!currentLeague?.id) return
        confirmAction(
            'Start Rookie Draft?',
            rookieDraftConfirmationMessage(rookieRounds, draftTimerSeconds, rookieTimerExpiryBehavior),
            async () => {
                setDraftLoading(true)
                try {
                    const result = await startRookieDraft(currentLeague.id, {
                        isMock: false,
                        timerSeconds: draftTimerSeconds,
                        rounds: rookieRounds,
                        timerExpiryBehavior: rookieTimerExpiryBehavior,
                    })
                    push({ pathname: '/(modals)/rookie-draft-room', params: { draftId: result.draft.id } })
                } catch (e: unknown) {
                    showAlert('Could not start rookie draft', e instanceof Error ? e.message : undefined)
                } finally {
                    setDraftLoading(false)
                }
            },
            'Start Rookie',
        )
    }

    async function handleReseedRookiePicks() {
        if (!currentLeague?.id) return
        setDraftLoading(true)
        try {
            const draft = await getActiveRookieDraft(currentLeague.id)
            if (!draft) { showAlert('No active rookie draft found'); return }
            await reseedRookieDraftPicks(draft.id)
            showAlert('Done', 'Pick slots updated to reflect traded picks.')
        } catch (e: unknown) {
            showAlert('Error', e instanceof Error ? e.message : undefined)
        } finally {
            setDraftLoading(false)
        }
    }

    async function handleCreateMockRoom() {
        if (!currentLeague?.id || !current?.id) return
        const scheduledAt = parseRoomDateInput(roomScheduledAt)
        if (!scheduledAt) {
            showAlert('Invalid start time', 'Use a date and time like 2026-07-01 19:30.')
            return
        }
        setRoomSubmitting(true)
        try {
            await createMockDraftRoom({
                leagueId: currentLeague.id,
                memberId: current.id,
                draftType: roomDraftType,
                roomName,
                scheduledAt,
                nominationOrderMode: nominationMode,
                timerSeconds: draftTimerSeconds,
                rounds: rookieRounds,
                timerExpiryBehavior: rookieTimerExpiryBehavior,
            })
            setRoomName('')
            setRoomScheduledAt(defaultRoomDateInput())
            await tabResources.refreshMockRooms()
        } catch (e: unknown) {
            showAlert('Could not create room', e instanceof Error ? e.message : undefined)
        } finally {
            setRoomSubmitting(false)
        }
    }

    function openDraftRoom(draftId: string, draftType: string) {
        push({
            pathname: draftType === 'snake' ? '/(modals)/rookie-draft-room' : '/(modals)/draft-room',
            params: { draftId },
        })
    }

    async function handleJoinMockRoom(room: MockDraftRoom) {
        if (!current?.id) return
        setDraftLoading(true)
        try {
            await joinMockDraftRoom(room.id, current.id)
            await tabResources.refreshMockRooms()
        } catch (e: unknown) {
            showAlert('Could not join room', e instanceof Error ? e.message : undefined)
        } finally {
            setDraftLoading(false)
        }
    }

    async function handleLeaveMockRoom(room: MockDraftRoom) {
        if (!current?.id) return
        setDraftLoading(true)
        try {
            await leaveMockDraftRoom(room.id, current.id)
            await tabResources.refreshMockRooms()
        } catch (e: unknown) {
            showAlert('Could not leave room', e instanceof Error ? e.message : undefined)
        } finally {
            setDraftLoading(false)
        }
    }

    async function handleStartMockRoom(room: MockDraftRoom) {
        if (!current?.id) return
        setDraftLoading(true)
        try {
            const draft = await startMockDraftRoom(room.id, current.id)
            openDraftRoom(draft.id, room.draftType)
        } catch (e: unknown) {
            showAlert('Could not start room', e instanceof Error ? e.message : undefined)
        } finally {
            setDraftLoading(false)
        }
    }

    async function shareInviteCode() {
        if (sharing) return
        setSharing(true)
        try {
            await Share.share({
                message: `Join my Pancake league! Use invite code: ${currentLeague?.invite_code}`,
            })
        } finally {
            setSharing(false)
        }
    }

    return {
        activeDraft,
        activeDraftError,
        activeDraftLoading,
        activityHasMore: tabResources.activityHasMore,
        activityLoadMoreError: tabResources.activityLoadMoreError,
        activityLoadingMore: tabResources.activityLoadingMore,
        current,
        currentLeague,
        currentLeaguePicks: tabResources.currentLeaguePicks,
        draftLoading,
        draftTimerSeconds,
        handleCreateMockRoom,
        handleJoinDraftRoom,
        handleJoinMockRoom,
        handleLeaveMockRoom,
        handleLoadMoreActivity: tabResources.loadMoreActivity,
        handleReseedRookiePicks,
        handleStartDraft,
        handleStartMockRoom,
        handleStartRookieDraft,
        handleTabChange,
        isCommissioner,
        leagueLoading,
        isTabLoading: tabResources.isTabLoading,
        mockRooms: tabResources.mockRooms,
        nominationMode,
        openBracket: () => push('/(modals)/bracket'),
        openCommissionerSettings: () => push('/(modals)/commissioner-settings'),
        openDraftRoom,
        openTeamRoster: (memberId: string, teamName: string) =>
            push({ pathname: '/(modals)/team-roster', params: { memberId, teamName } }),
        retryActiveDraft: () => currentLeague?.id && fetchActiveDraft(currentLeague.id),
        retryCurrentTab: () => currentLeague?.id && tabResources.fetchTab(tab, currentLeague.id),
        rookieRounds,
        rookieTimerExpiryBehavior,
        roomDraftType,
        roomName,
        roomScheduledAt,
        roomSubmitting,
        setDraftTimerSeconds,
        setNominationMode,
        setRookieRounds,
        setRookieTimerExpiryBehavior,
        setRoomDraftType,
        setRoomName,
        setRoomScheduledAt,
        shareInviteCode,
        standings: tabResources.standings,
        tab,
        tabErr: tabResources.tabError,
        transactions: tabResources.transactions,
        waiverOrder: tabResources.waiverOrder,
    }
}
