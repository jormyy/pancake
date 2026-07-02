import {
    View,
    Text,
    Pressable,
    StyleSheet,
    Share,
    ScrollView,
    TextInput,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState, useRef, useCallback, useEffect } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useLeagueContext } from '@/contexts/league-context'
import { getLeagueStandings, StandingRow } from '@/lib/scoring'
import {
    getJoinableDraft,
    startDraft,
    NOMINATION_ORDER_MODES,
    NOMINATION_ORDER_MODE_LABELS,
    ROOKIE_TIMER_EXPIRY_BEHAVIORS,
    ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS,
    type Draft,
    type NominationOrderMode,
    type RookieTimerExpiryBehavior,
} from '@/lib/draft'
import { getWaiverPriorityOrder, WaiverPriorityRow } from '@/lib/waivers'
import { getLeagueTransactions, TransactionRow } from '@/lib/transactions'
import { getActiveRookieDraft, startRookieDraft, getAllLeaguePicks, reseedRookieDraftPicks, LeaguePickItem } from '@/lib/rookieDraft'
import {
    createMockDraftRoom,
    getMockDraftRooms,
    joinMockDraftRoom,
    leaveMockDraftRoom,
    startMockDraftRoom,
    type MockDraftRoom,
    type MockDraftRoomKind,
    type MockDraftRoomStatus,
} from '@/lib/mockDraftRooms'
import { colors, fontSize, fontWeight, radii, spacing, layout } from '@/constants/tokens'
import { EmptyState } from '@/components/EmptyState'
import { StandingsTable, ActivityFeed, PicksBankList } from '@/components/league/LeagueSections'
import { confirmAction, showAlert } from '@/lib/alert'

type Tab = 'results' | 'auctions' | 'mockRooms' | 'draftBoard' | 'settings' | 'history'
type ChipValue = string | number
type ChipOption<T extends ChipValue> = {
    value: T
    label: string
}

const ACTIVITY_LIMIT = 50
const DRAFT_TIMER_OPTIONS = [30, 60, 120] as const
const ROOKIE_ROUND_OPTIONS = [2, 3, 4] as const
const MOCK_ROOM_TYPE_CHIPS: readonly ChipOption<MockDraftRoomKind>[] = [
    { value: 'auction', label: 'Auction' },
    { value: 'snake', label: 'Rookie' },
]
const DRAFT_TIMER_CHIPS: readonly ChipOption<(typeof DRAFT_TIMER_OPTIONS)[number]>[] =
    DRAFT_TIMER_OPTIONS.map((value) => ({ value, label: `${value}s` }))
const ROOKIE_ROUND_CHIPS: readonly ChipOption<(typeof ROOKIE_ROUND_OPTIONS)[number]>[] =
    ROOKIE_ROUND_OPTIONS.map((value) => ({ value, label: String(value) }))
const NOMINATION_ORDER_CHIPS: readonly ChipOption<NominationOrderMode>[] =
    NOMINATION_ORDER_MODES.map((value) => ({ value, label: NOMINATION_ORDER_MODE_LABELS[value] }))
const ROOKIE_TIMER_EXPIRY_CHIPS: readonly ChipOption<RookieTimerExpiryBehavior>[] =
    ROOKIE_TIMER_EXPIRY_BEHAVIORS.map((value) => ({ value, label: ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS[value] }))
const OPEN_DRAFT_STATUSES = new Set(['pending', 'in_progress', 'paused'])
const ROOM_STATUS_LABELS: Record<MockDraftRoomStatus, string> = {
    active: 'Active',
    scheduled: 'Scheduled',
    live: 'Live',
    completed: 'Completed',
}

function parseLeagueTab(tab: unknown): Tab {
    return tab === 'auctions' ||
        tab === 'mockRooms' ||
        tab === 'draftBoard' ||
        tab === 'settings' ||
        tab === 'history'
        ? tab
        : 'results'
}

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

function formatRoomTime(value: string | null): string {
    if (!value) return 'Now'
    return new Date(value).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    })
}

export default function LeagueScreen() {
    const router = useRouter()
    const { push } = router
    const params = useLocalSearchParams<{ tab?: string }>()
    const { current, currentLeague, isCommissioner } = useLeagueContext()
    const [tab, setTab] = useState<Tab>(() => parseLeagueTab(params.tab))
    const [draftLoading, setDraftLoading] = useState(false)
    const [nominationMode, setNominationMode] = useState<NominationOrderMode>('user_nominated')
    const [draftTimerSeconds, setDraftTimerSeconds] = useState<(typeof DRAFT_TIMER_OPTIONS)[number]>(30)
    const [rookieRounds, setRookieRounds] = useState<(typeof ROOKIE_ROUND_OPTIONS)[number]>(3)
    const [rookieTimerExpiryBehavior, setRookieTimerExpiryBehavior] =
        useState<RookieTimerExpiryBehavior>('auto_pick')
    const [activeDraft, setActiveDraft] = useState<Draft | null>(null)
    const [activeDraftLoading, setActiveDraftLoading] = useState(false)
    const [roomName, setRoomName] = useState('')
    const [roomDraftType, setRoomDraftType] = useState<MockDraftRoomKind>('auction')
    const [roomScheduledAt, setRoomScheduledAt] = useState(defaultRoomDateInput)
    const [roomSubmitting, setRoomSubmitting] = useState(false)

    // Per-tab data
    const [standings, setStandings] = useState<StandingRow[]>([])
    const [transactions, setTransactions] = useState<TransactionRow[]>([])
    const [waiverOrder, setWaiverOrder] = useState<WaiverPriorityRow[]>([])
    const [currentLeaguePicks, setCurrentLeaguePicks] = useState<LeaguePickItem[]>([])
    const [mockRooms, setMockRooms] = useState<MockDraftRoom[]>([])
    const [activityOffset, setActivityOffset] = useState(0)
    const [activityHasMore, setActivityHasMore] = useState(false)
    const [activityLoadingMore, setActivityLoadingMore] = useState(false)

    // Per-tab loading / error
    const [tabLoading, setTabLoading] = useState<Partial<Record<Tab, boolean>>>({ results: true })
    const [tabError, setTabError] = useState<Partial<Record<Tab, string>>>({})

    // Lazy loading: track which tabs have been fetched
    const loadedTabs = useRef<Set<Tab>>(new Set())
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
        setActivityOffset(0)
        setActivityHasMore(false)
        setActivityLoadingMore(false)
        setTabError({})
        setTabLoading({ results: true })
    }, [currentLeague?.id])

    const fetchActiveDraft = useCallback(async (lid: string) => {
        setActiveDraftLoading(true)
        try {
            const draft = await getJoinableDraft(lid, { includeCompletedRookie: true })
            if (activeLeagueIdRef.current !== lid) return
            setActiveDraft(draft)
        } catch {
            if (activeLeagueIdRef.current === lid) setActiveDraft(null)
        } finally {
            if (activeLeagueIdRef.current === lid) setActiveDraftLoading(false)
        }
    }, [])

    const fetchTab = useCallback(async (t: Tab, lid: string) => {
        setTabLoading((prev) => ({ ...prev, [t]: true }))
        setTabError((prev) => { const next = { ...prev }; delete next[t]; return next })
        try {
            let commit: () => void = () => {}
            switch (t) {
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
            // Drop the result if the active league changed while this tab loaded.
            if (activeLeagueIdRef.current !== lid) return
            commit()
            loadedTabs.current.add(t)
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : 'Unknown error'
            setTabError((prev) => ({ ...prev, [t]: msg }))
        } finally {
            setTabLoading((prev) => ({ ...prev, [t]: false }))
        }
    }, [current?.id])

    // On screen focus: fetch standings once, then fetch current tab if not loaded
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

    // When switching tabs, fetch if not yet loaded
    function handleTabChange(t: Tab) {
        setTab(t)
        router.push(`/league?tab=${t}`)
        const lid = currentLeague?.id
        if (!lid) return
        if (!loadedTabs.current.has(t)) {
            fetchTab(t, lid)
        }
    }

    // Activity pagination
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
        } catch {
            // silently fail on pagination errors
        } finally {
            setActivityLoadingMore(false)
        }
    }

    async function handleStartDraft() {
        if (!currentLeague?.id) return
        confirmAction(
            'Start Auction Draft?',
            'This will begin the auction draft for all teams. This cannot be undone.',
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
            'Start Draft',
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
            if (draft.draftType === 'snake') {
                push({ pathname: '/(modals)/rookie-draft-room', params: { draftId: draft.id } })
            } else {
                push({ pathname: '/(modals)/draft-room', params: { draftId: draft.id } })
            }
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
            'This will begin the rookie snake draft. This cannot be undone.',
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
            'Start Draft',
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
        if (draftType === 'snake') {
            push({ pathname: '/(modals)/rookie-draft-room', params: { draftId } })
        } else {
            push({ pathname: '/(modals)/draft-room', params: { draftId } })
        }
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

    const [sharing, setSharing] = useState(false)
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

    if (!current) {
        return <EmptyState message="Join or create a league first." />
    }

    const isTabLoading = tabLoading[tab] === true
    const tabErr = tabError[tab]

    function renderDraftChips<T extends ChipValue>(
        options: readonly ChipOption<T>[],
        selectedValue: T,
        onSelect: (value: T) => void,
    ) {
        return (
            <View style={styles.nominationModeRow}>
                {options.map((option) => {
                    const selected = selectedValue === option.value
                    return (
                        <Pressable
                            key={String(option.value)}
                            style={[styles.nominationModeChip, selected && styles.nominationModeChipOn]}
                            onPress={() => onSelect(option.value)}
                            accessibilityRole="button"
                            accessibilityState={{ selected }}
                        >
                            <Text style={[styles.nominationModeChipText, selected && styles.nominationModeChipTextOn]}>
                                {option.label}
                            </Text>
                        </Pressable>
                    )
                })}
            </View>
        )
    }

    function activeDraftButtonLabel(draft: Draft) {
        const mock = draft.isMock ? 'Mock ' : ''
        const kind = draft.draftType === 'snake' ? 'Rookie Draft' : 'Auction Draft'
        if (draft.status === 'completed' && draft.draftType === 'snake') return 'Resolve Rookie Draft'
        return `${draft.status === 'paused' ? 'Resume' : 'Join'} ${mock}${kind}`
    }

    function renderActiveDraftEntry(filterType?: 'auction' | 'snake') {
        if (activeDraftLoading) {
            return null
        }

        if (activeDraft && (!filterType || activeDraft.draftType === filterType)) {
            return (
                <View style={styles.panelCard}>
                    <Text style={styles.panelTitle}>Live Draft</Text>
                    <Pressable style={styles.draftButton} onPress={handleJoinDraftRoom} disabled={draftLoading}>
                        <Text style={styles.draftButtonText}>{activeDraftButtonLabel(activeDraft)}</Text>
                    </Pressable>
                    {OPEN_DRAFT_STATUSES.has(activeDraft.status) && activeDraft.draftType === 'snake' && !activeDraft.isMock && isCommissioner ? (
                        <View style={styles.syncWrap}>
                            <Pressable style={styles.secondaryDraftButton} onPress={handleReseedRookiePicks} disabled={draftLoading}>
                                <Text style={styles.secondaryDraftButtonText}>Sync Traded Picks</Text>
                            </Pressable>
                            <Text style={styles.syncHint}>Commissioner only — pull in picks acquired via trade so the draft board is current.</Text>
                        </View>
                    ) : null}
                </View>
            )
        }
        return null
    }

    function renderAuctionTab() {
        const activeAuction = renderActiveDraftEntry('auction')
        return (
            <ScrollView
                contentContainerStyle={styles.panelScroll}
            >
                {activeAuction}
                {currentLeague?.status === 'setup' && isCommissioner ? (
                    <View style={styles.panelCard}>
                        <Text style={styles.panelTitle}>Auction</Text>
                        <Text style={styles.nominationModeLabel}>Timer</Text>
                        {renderDraftChips(DRAFT_TIMER_CHIPS, draftTimerSeconds, setDraftTimerSeconds)}
                        <Text style={styles.nominationModeLabel}>Nomination order</Text>
                        {renderDraftChips(NOMINATION_ORDER_CHIPS, nominationMode, setNominationMode)}
                        <Pressable style={styles.draftButton} onPress={handleStartDraft} disabled={draftLoading}>
                            <Text style={styles.draftButtonText}>Start Auction Draft</Text>
                        </Pressable>
                    </View>
                ) : null}
                {!activeAuction && !(currentLeague?.status === 'setup' && isCommissioner) ? (
                    <EmptyState message="No auction draft is available right now." fullScreen={false} />
                ) : null}
            </ScrollView>
        )
    }

    function renderDraftBoardTab() {
        return (
            <View style={styles.boardWrap}>
                <View style={styles.boardTop}>
                    {renderActiveDraftEntry('snake')}
                    {currentLeague?.status === 'offseason' && isCommissioner ? (
                        <View style={styles.panelCard}>
                            <Text style={styles.panelTitle}>Rookie Draft</Text>
                            <Text style={styles.nominationModeLabel}>Timer</Text>
                            {renderDraftChips(DRAFT_TIMER_CHIPS, draftTimerSeconds, setDraftTimerSeconds)}
                            <Text style={styles.nominationModeLabel}>Rookie rounds</Text>
                            {renderDraftChips(ROOKIE_ROUND_CHIPS, rookieRounds, setRookieRounds)}
                            <Text style={styles.nominationModeLabel}>Timeout behavior</Text>
                            {renderDraftChips(ROOKIE_TIMER_EXPIRY_CHIPS, rookieTimerExpiryBehavior, setRookieTimerExpiryBehavior)}
                            <Pressable style={styles.draftButton} onPress={handleStartRookieDraft} disabled={draftLoading}>
                                <Text style={styles.draftButtonText}>Start Rookie Draft</Text>
                            </Pressable>
                        </View>
                    ) : null}
                </View>
                <View style={styles.boardList}>
                    <PicksBankList picks={currentLeaguePicks} myMemberId={current?.id} />
                </View>
            </View>
        )
    }

    function renderRoomAction(room: MockDraftRoom) {
        if (room.roomStatus === 'live' || room.roomStatus === 'completed') {
            return (
                <Pressable
                    style={styles.secondaryDraftButton}
                    onPress={() => openDraftRoom(room.id, room.draftType)}
                    disabled={draftLoading}
                >
                    <Text style={styles.secondaryDraftButtonText}>
                        {room.roomStatus === 'live' ? 'Enter Room' : 'View Room'}
                    </Text>
                </Pressable>
            )
        }
        if (!room.isJoined) {
            return (
                <Pressable
                    style={styles.secondaryDraftButton}
                    onPress={() => handleJoinMockRoom(room)}
                    disabled={draftLoading}
                >
                    <Text style={styles.secondaryDraftButtonText}>Join Room</Text>
                </Pressable>
            )
        }
        if (room.isCreator && room.roomStatus === 'active') {
            const canStart = room.participants.length >= 2
            return (
                <Pressable
                    style={[styles.draftButton, !canStart && styles.draftButtonDisabled]}
                    onPress={() => handleStartMockRoom(room)}
                    disabled={draftLoading || !canStart}
                >
                    <Text style={styles.draftButtonText}>Start Room</Text>
                </Pressable>
            )
        }
        if (!room.isCreator) {
            return (
                <Pressable
                    style={styles.secondaryDraftButton}
                    onPress={() => handleLeaveMockRoom(room)}
                    disabled={draftLoading}
                >
                    <Text style={styles.secondaryDraftButtonText}>Leave Room</Text>
                </Pressable>
            )
        }
        return null
    }

    function renderRoomCard(room: MockDraftRoom) {
        return (
            <View key={room.id} style={styles.roomCard}>
                <View style={styles.roomCardTop}>
                    <View style={styles.roomTitleWrap}>
                        <Text style={styles.roomTitle} numberOfLines={1}>{room.roomName}</Text>
                        <Text style={styles.roomMeta} numberOfLines={1}>
                            {room.draftType === 'snake' ? 'Rookie' : 'Auction'} · {formatRoomTime(room.scheduledAt)}
                        </Text>
                    </View>
                    <View style={styles.roomStatusPill}>
                        <Text style={styles.roomStatusText}>{ROOM_STATUS_LABELS[room.roomStatus]}</Text>
                    </View>
                </View>
                <Text style={styles.roomMeta} numberOfLines={2}>
                    Creator: {room.creatorTeamName} · Joined: {room.participants.map((p) => p.teamName).join(', ') || 'None'}
                </Text>
                {renderRoomAction(room)}
            </View>
        )
    }

    function renderMockRoomsTab() {
        const statuses: MockDraftRoomStatus[] = ['active', 'scheduled', 'live', 'completed']
        return (
            <ScrollView
                contentContainerStyle={styles.panelScroll}
            >
                <View style={styles.panelCard}>
                    <Text style={styles.panelTitle}>Mock Draft Room</Text>
                    <TextInput
                        style={styles.textInput}
                        value={roomName}
                        onChangeText={setRoomName}
                        placeholder="Room name"
                    />
                    <Text style={styles.nominationModeLabel}>Room type</Text>
                    {renderDraftChips(MOCK_ROOM_TYPE_CHIPS, roomDraftType, setRoomDraftType)}
                    <Text style={styles.nominationModeLabel}>Starts</Text>
                    <TextInput
                        style={styles.textInput}
                        value={roomScheduledAt}
                        onChangeText={setRoomScheduledAt}
                        placeholder="2026-07-01 19:30"
                        autoCapitalize="none"
                    />
                    <Text style={styles.nominationModeLabel}>Timer</Text>
                    {renderDraftChips(DRAFT_TIMER_CHIPS, draftTimerSeconds, setDraftTimerSeconds)}
                    {roomDraftType === 'auction' ? (
                        <>
                            <Text style={styles.nominationModeLabel}>Nomination order</Text>
                            {renderDraftChips(NOMINATION_ORDER_CHIPS, nominationMode, setNominationMode)}
                        </>
                    ) : (
                        <>
                            <Text style={styles.nominationModeLabel}>Rookie rounds</Text>
                            {renderDraftChips(ROOKIE_ROUND_CHIPS, rookieRounds, setRookieRounds)}
                            <Text style={styles.nominationModeLabel}>Timeout behavior</Text>
                            {renderDraftChips(ROOKIE_TIMER_EXPIRY_CHIPS, rookieTimerExpiryBehavior, setRookieTimerExpiryBehavior)}
                        </>
                    )}
                    <Pressable style={styles.draftButton} onPress={handleCreateMockRoom} disabled={roomSubmitting}>
                        <Text style={styles.draftButtonText}>Create Room</Text>
                    </Pressable>
                </View>

                {statuses.map((status) => {
                    const rooms = mockRooms.filter((room) => room.roomStatus === status)
                    return (
                        <View key={status} style={styles.roomSection}>
                            <Text style={styles.sectionLabel}>{ROOM_STATUS_LABELS[status]}</Text>
                            {rooms.length ? rooms.map(renderRoomCard) : (
                                <Text style={styles.emptySectionText}>No {ROOM_STATUS_LABELS[status].toLowerCase()} rooms.</Text>
                            )}
                        </View>
                    )
                })}
            </ScrollView>
        )
    }

    function renderSettingsTab() {
        return (
            <ScrollView contentContainerStyle={styles.panelScroll}>
                <Pressable style={styles.inviteRow} onPress={shareInviteCode}>
                    <Text style={styles.inviteLabel}>Invite Code</Text>
                    <Text style={styles.inviteCode}>{currentLeague?.invite_code}</Text>
                    <Text style={styles.inviteCopy}>Share</Text>
                </Pressable>
                <View style={styles.settingsActionRow}>
                    <Pressable style={styles.secondaryDraftButton} onPress={() => push('/(modals)/bracket')}>
                        <Text style={styles.secondaryDraftButtonText}>Bracket</Text>
                    </Pressable>
                    {isCommissioner ? (
                        <Pressable style={styles.secondaryDraftButton} onPress={() => push('/(modals)/commissioner-settings')}>
                            <Text style={styles.secondaryDraftButtonText}>Commissioner Settings</Text>
                        </Pressable>
                    ) : null}
                </View>
                {waiverOrder.length ? (
                    <View style={styles.panelCard}>
                        <Text style={styles.panelTitle}>Waiver Priority</Text>
                        {waiverOrder.map((row, index) => (
                            <View key={row.memberId} style={styles.settingListRow}>
                                <Text style={styles.settingListRank}>{index + 1}</Text>
                                <Text style={styles.settingListTeam} numberOfLines={1}>{row.teamName}</Text>
                                <Text style={styles.settingListName} numberOfLines={1}>{row.displayName}</Text>
                            </View>
                        ))}
                    </View>
                ) : null}
            </ScrollView>
        )
    }

    function renderTabContent() {
        if (tabErr && !isTabLoading) {
            return (
                <Pressable
                    style={styles.errorBanner}
                    onPress={() => currentLeague?.id && fetchTab(tab, currentLeague.id)}
                >
                    <Text style={styles.errorBannerText}>Failed to load. Tap to retry.</Text>
                </Pressable>
            )
        }
        if (tab === 'results') {
            return (
                <StandingsTable
                    standings={standings}
                    myMemberId={current?.id}
                    onSelectTeam={(memberId, teamName) =>
                        push({ pathname: '/(modals)/team-roster', params: { memberId, teamName } })
                    }
                />
            )
        }
        if (tab === 'auctions') return renderAuctionTab()
        if (tab === 'mockRooms') return renderMockRoomsTab()
        if (tab === 'draftBoard') return renderDraftBoardTab()
        if (tab === 'settings') return renderSettingsTab()
        return (
            <ActivityFeed
                transactions={transactions}
                myMemberId={current?.id}
                onLoadMore={handleLoadMoreActivity}
                hasMore={activityHasMore && !activityLoadingMore}
            />
        )
    }

    return (
        <SafeAreaView style={styles.container}>
          <View style={styles.contentWrap}>
            {/* Header */}
            <View style={styles.header}>
                <View style={styles.headerTop}>
                    <View style={styles.headerInfo}>
                        <Text style={styles.currentLeagueName} numberOfLines={2}>{currentLeague?.name}</Text>
                        <Text style={styles.teamName} numberOfLines={1}>{current.team_name}</Text>
                    </View>
                </View>
            </View>

            {/* Tab switcher — wraps to a second row on narrow widths so every pill
                stays reachable (no horizontal clip at 320). */}
            <View style={styles.tabRow}>
                {(['results', 'auctions', 'mockRooms', 'draftBoard', 'settings', 'history'] as Tab[]).map((t) => (
                    <Pressable
                        key={t}
                        style={[styles.tabChip, tab === t && styles.tabChipActive]}
                        onPress={() => handleTabChange(t)}
                    >
                        <Text style={[styles.tabChipText, tab === t && styles.tabChipTextActive]}>
                            {t === 'results' ? 'Results'
                                : t === 'auctions' ? 'Auctions'
                                : t === 'mockRooms' ? 'Mock Rooms'
                                : t === 'draftBoard' ? 'Draft Board'
                                : t === 'settings' ? 'Settings'
                                : 'History'}
                        </Text>
                    </Pressable>
                ))}
            </View>

            {/* Tab content — each tab's FlashList is the scroll container so it
                virtualizes (no wrapping vertical ScrollView). */}
            <View style={styles.contentScroll}>{renderTabContent()}</View>
          </View>
        </SafeAreaView>
    )
}


const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    contentWrap: { flex: 1, width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center' },

    header: { padding: spacing['2xl'], borderBottomWidth: 1, borderBottomColor: colors.borderLight, gap: spacing.lg },
    headerTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.lg },
    headerInfo: { flex: 1, minWidth: 0, gap: spacing.xxs },
    currentLeagueName: { fontSize: fontSize.xl, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    teamName: { fontSize: fontSize.md, color: colors.textMuted },

    headerButtons: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
    settingsButton: {
        paddingHorizontal: spacing.lg,
        paddingVertical: 7,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
    },
    settingsButtonText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },

    draftButton: {
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        height: 44,
        justifyContent: 'center',
        alignItems: 'center',
    },
    draftButtonDisabled: { opacity: 0.5 },
    draftButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 15 },
    secondaryDraftButton: {
        backgroundColor: colors.bgSubtle,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
        height: 44,
        justifyContent: 'center',
        alignItems: 'center',
    },
    secondaryDraftButtonText: { color: colors.textSecondary, fontWeight: fontWeight.bold, fontSize: 15 },
    syncWrap: { gap: spacing.xs, marginTop: spacing.md },
    syncHint: { fontSize: fontSize.xs, color: colors.textMuted, paddingHorizontal: spacing.xs, lineHeight: 15 },
    nominationModeLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0,
        marginBottom: spacing.xs,
    },
    nominationModeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
    nominationModeChip: {
        flexGrow: 1,
        flexBasis: 78,
        paddingVertical: spacing.sm,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgCard,
        alignItems: 'center',
    },
    nominationModeChipOn: { borderColor: colors.primary, backgroundColor: colors.bgSubtle },
    nominationModeChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    nominationModeChipTextOn: { color: colors.primaryDark },

    panelScroll: {
        padding: spacing.xl,
        gap: spacing.lg,
        width: '100%',
        maxWidth: 760,
        alignSelf: 'center',
        paddingBottom: spacing['3xl'],
    },
    panelCard: {
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        padding: spacing.xl,
        gap: spacing.md,
    },
    panelTitle: {
        fontSize: fontSize.lg,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    textInput: {
        height: 44,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.lg,
        fontSize: fontSize.md,
        color: colors.textPrimary,
        backgroundColor: colors.bgScreen,
    },
    boardWrap: { flex: 1 },
    boardTop: {
        padding: spacing.xl,
        gap: spacing.lg,
        width: '100%',
        maxWidth: 760,
        alignSelf: 'center',
    },
    boardList: { flex: 1 },
    roomSection: { gap: spacing.sm },
    sectionLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0,
        marginLeft: spacing.xs,
    },
    roomCard: {
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        padding: spacing.lg,
        gap: spacing.md,
    },
    roomCardTop: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
    roomTitleWrap: { flex: 1, minWidth: 0 },
    roomTitle: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    roomMeta: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 18 },
    roomStatusPill: {
        paddingHorizontal: spacing.md,
        paddingVertical: 4,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgSubtle,
        borderWidth: 1,
        borderColor: colors.borderLight,
    },
    roomStatusText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textSecondary },
    emptySectionText: {
        fontSize: fontSize.sm,
        color: colors.textPlaceholder,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.xs,
    },
    settingsActionRow: { gap: spacing.md },
    settingListRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.sm,
        borderTopWidth: 1,
        borderTopColor: colors.separator,
    },
    settingListRank: { width: 28, fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textSecondary },
    settingListTeam: { flex: 1, minWidth: 0, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    settingListName: { width: 120, textAlign: 'right', fontSize: fontSize.sm, color: colors.textMuted },

    inviteRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: spacing.md,
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 14,
        paddingVertical: spacing.lg,
    },
    inviteLabel: { fontSize: fontSize.sm, color: colors.textMuted, flex: 1 },
    inviteCode: { flexShrink: 1, fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: colors.textPrimary, letterSpacing: 0 },
    inviteCopy: { fontSize: fontSize.sm, color: colors.primaryDark, fontWeight: fontWeight.semibold },

    tabRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    tabChip: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    tabChipActive: { backgroundColor: colors.primary },
    tabChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    tabChipTextActive: { color: colors.textWhite },

    contentScroll: { flex: 1 },

    errorBanner: {
        margin: spacing['2xl'],
        padding: spacing['2xl'],
        backgroundColor: colors.dangerLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
    },
    errorBannerText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.dangerDark },
})
