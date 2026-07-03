import { Share } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useLeagueContext } from '@/contexts/league-context'
import { getLeagueStandings, type StandingRow } from '@/lib/scoring'
import {
    getJoinableDraft,
    NOMINATION_ORDER_MODE_LABELS,
    ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS,
    startDraft,
    type Draft,
    type NominationOrderMode,
    type RookieTimerExpiryBehavior,
} from '@/lib/draft'
import { getWaiverPriorityOrder, type WaiverPriorityRow } from '@/lib/waivers'
import { getLeagueTransactions, type TransactionRow } from '@/lib/transactions'
import {
    getActiveRookieDraft,
    startRookieDraft,
    getAllLeaguePicks,
    reseedRookieDraftPicks,
    type LeaguePickItem,
} from '@/lib/rookieDraft'
import {
    createMockDraftRoom,
    getMockDraftRooms,
    joinMockDraftRoom,
    leaveMockDraftRoom,
    startMockDraftRoom,
    type MockDraftRoom,
    type MockDraftRoomKind,
} from '@/lib/mockDraftRooms'
import { confirmAction, showAlert } from '@/lib/alert'
import { parseLeagueTab, type LeagueTab } from '@/lib/league/tabs'
import type { DraftTimerOption, RookieRoundOption } from '@/components/league/LeagueDraftPanels'

const ACTIVITY_LIMIT = 50
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
    const [draftTimerSeconds, setDraftTimerSeconds] = useState<DraftTimerOption>(30)
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
    const [sharing, setSharing] = useState(false)

    const loadedTabs = useRef<Set<LeagueTab>>(new Set())
    const activeLeagueIdRef = useRef<string | undefined>(undefined)
    activeLeagueIdRef.current = currentLeague?.id

    useEffect(() => {
        setTab(parseLeagueTab(params.tab))
    }, [params.tab])

    useEffect(() => {
        loadedTabs.current.clear()
        setStandings([])
        setTransactions([])
        setWaiverOrder([])
        setCurrentLeaguePicks([])
        setMockRooms([])
        setActiveDraft(null)
        setActiveDraftError(null)
        setActiveDraftLoading(Boolean(currentLeague?.id))
        setActivityOffset(0)
        setActivityHasMore(false)
        setActivityLoadingMore(false)
        setActivityLoadMoreError(null)
        setTabError({})
        setTabLoading({ results: true })
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

    const fetchTab = useCallback(async (nextTab: LeagueTab, lid: string) => {
        setTabLoading((prev) => ({ ...prev, [nextTab]: true }))
        setTabError((prev) => { const next = { ...prev }; delete next[nextTab]; return next })
        try {
            let commit: () => void = () => {}
            switch (nextTab) {
                case 'results': {
                    const data = await getLeagueStandings(lid)
                    commit = () => setStandings(data)
                    break
                }
                case 'history': {
                    const data = await getLeagueTransactions(lid, ACTIVITY_LIMIT, 0)
                    commit = () => {
                        setTransactions(data)
                        setActivityOffset(0)
                        setActivityHasMore(data.length === ACTIVITY_LIMIT)
                    }
                    break
                }
                case 'settings': {
                    const data = await getWaiverPriorityOrder(lid)
                    commit = () => setWaiverOrder(data)
                    break
                }
                case 'draftBoard': {
                    const data = await getAllLeaguePicks(lid)
                    commit = () => setCurrentLeaguePicks(data)
                    break
                }
                case 'mockRooms': {
                    if (!current?.id) break
                    const data = await getMockDraftRooms(lid, current.id)
                    commit = () => setMockRooms(data)
                    break
                }
                case 'auctions': {
                    break
                }
            }
            if (activeLeagueIdRef.current !== lid) return
            commit()
            loadedTabs.current.add(nextTab)
        } catch (e: unknown) {
            setTabError((prev) => ({ ...prev, [nextTab]: e instanceof Error ? e.message : 'Unknown error' }))
        } finally {
            setTabLoading((prev) => ({ ...prev, [nextTab]: false }))
        }
    }, [current?.id])

    useFocusEffect(
        useCallback(() => {
            const lid = currentLeague?.id
            if (!lid) return
            if (!loadedTabs.current.has('results')) {
                fetchTab('results', lid)
            }
            if (tab !== 'results' && !loadedTabs.current.has(tab)) {
                fetchTab(tab, lid)
            }
            fetchActiveDraft(lid)
        }, [currentLeague?.id, tab, fetchTab, fetchActiveDraft]),
    )

    function handleTabChange(nextTab: LeagueTab) {
        setTab(nextTab)
        router.push(`/league?tab=${nextTab}`)
        const lid = currentLeague?.id
        if (lid && !loadedTabs.current.has(nextTab)) {
            fetchTab(nextTab, lid)
        }
    }

    async function handleLoadMoreActivity() {
        const lid = currentLeague?.id
        if (!lid || activityLoadingMore) return
        setActivityLoadingMore(true)
        try {
            const nextOffset = activityOffset + ACTIVITY_LIMIT
            const data = await getLeagueTransactions(lid, ACTIVITY_LIMIT, nextOffset)
            setTransactions((prev) => [...prev, ...data])
            setActivityOffset(nextOffset)
            setActivityHasMore(data.length === ACTIVITY_LIMIT)
            setActivityLoadMoreError(null)
        } catch (e: unknown) {
            setActivityLoadMoreError(e instanceof Error ? e.message : 'Could not load more activity')
        } finally {
            setActivityLoadingMore(false)
        }
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

    async function reloadMockRooms() {
        if (!currentLeague?.id || !current?.id) return
        const rooms = await getMockDraftRooms(currentLeague.id, current.id)
        setMockRooms(rooms)
        loadedTabs.current.add('mockRooms')
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
            await reloadMockRooms()
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
            await reloadMockRooms()
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
            await reloadMockRooms()
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
        activityHasMore,
        activityLoadMoreError,
        activityLoadingMore,
        current,
        currentLeague,
        currentLeaguePicks,
        draftLoading,
        draftTimerSeconds,
        handleCreateMockRoom,
        handleJoinDraftRoom,
        handleJoinMockRoom,
        handleLeaveMockRoom,
        handleLoadMoreActivity,
        handleReseedRookiePicks,
        handleStartDraft,
        handleStartMockRoom,
        handleStartRookieDraft,
        handleTabChange,
        isCommissioner,
        leagueLoading,
        isTabLoading: tabLoading[tab] === true,
        mockRooms,
        nominationMode,
        openBracket: () => push('/(modals)/bracket'),
        openCommissionerSettings: () => push('/(modals)/commissioner-settings'),
        openDraftRoom,
        openTeamRoster: (memberId: string, teamName: string) =>
            push({ pathname: '/(modals)/team-roster', params: { memberId, teamName } }),
        retryActiveDraft: () => currentLeague?.id && fetchActiveDraft(currentLeague.id),
        retryCurrentTab: () => currentLeague?.id && fetchTab(tab, currentLeague.id),
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
        standings,
        tab,
        tabErr: tabError[tab],
        transactions,
        waiverOrder,
    }
}
