import {
    View,
    Text,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    Share,
    RefreshControl,
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
import { colors, fontSize, fontWeight, radii, spacing, layout } from '@/constants/tokens'
import { LoadingScreen } from '@/components/LoadingScreen'
import { EmptyState } from '@/components/EmptyState'
import { StandingsTable, ActivityFeed, WaiverPriorityList, PicksBankList } from '@/components/league/LeagueSections'
import { confirmAction, showAlert } from '@/lib/alert'

type Tab = 'standings' | 'activity' | 'waivers' | 'picks'
type DraftMode = 'real' | 'mock'
type ChipValue = string | number
type ChipOption<T extends ChipValue> = {
    value: T
    label: string
}

const ACTIVITY_LIMIT = 50
const DRAFT_TIMER_OPTIONS = [30, 60, 120] as const
const ROOKIE_ROUND_OPTIONS = [2, 3, 4] as const
const DRAFT_MODE_CHIPS: readonly ChipOption<DraftMode>[] = [
    { value: 'real', label: 'Real' },
    { value: 'mock', label: 'Mock' },
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

function parseLeagueTab(tab: unknown): Tab {
    return tab === 'activity' || tab === 'waivers' || tab === 'picks' ? tab : 'standings'
}

export default function LeagueScreen() {
    const router = useRouter()
    const { push } = router
    const params = useLocalSearchParams<{ tab?: string }>()
    const { current, currentLeague, isCommissioner, loading: currentLeagueLoading } = useLeagueContext()
    const [tab, setTab] = useState<Tab>(() => parseLeagueTab(params.tab))
    const [draftLoading, setDraftLoading] = useState(false)
    const [nominationMode, setNominationMode] = useState<NominationOrderMode>('user_nominated')
    const [draftMode, setDraftMode] = useState<DraftMode>('real')
    const [draftTimerSeconds, setDraftTimerSeconds] = useState<(typeof DRAFT_TIMER_OPTIONS)[number]>(30)
    const [rookieRounds, setRookieRounds] = useState<(typeof ROOKIE_ROUND_OPTIONS)[number]>(3)
    const [rookieTimerExpiryBehavior, setRookieTimerExpiryBehavior] =
        useState<RookieTimerExpiryBehavior>('auto_pick')
    const [activeDraft, setActiveDraft] = useState<Draft | null>(null)
    const [activeDraftLoading, setActiveDraftLoading] = useState(false)

    // Per-tab data
    const [standings, setStandings] = useState<StandingRow[]>([])
    const [transactions, setTransactions] = useState<TransactionRow[]>([])
    const [waiverOrder, setWaiverOrder] = useState<WaiverPriorityRow[]>([])
    const [currentLeaguePicks, setCurrentLeaguePicks] = useState<LeaguePickItem[]>([])
    const [activityOffset, setActivityOffset] = useState(0)
    const [activityHasMore, setActivityHasMore] = useState(false)
    const [activityLoadingMore, setActivityLoadingMore] = useState(false)

    // Per-tab loading / error
    const [tabLoading, setTabLoading] = useState<Partial<Record<Tab, boolean>>>({ standings: true })
    const [tabError, setTabError] = useState<Partial<Record<Tab, string>>>({})

    // Lazy loading: track which tabs have been fetched
    const loadedTabs = useRef<Set<Tab>>(new Set())
    const activeLeagueIdRef = useRef<string | undefined>(undefined)
    activeLeagueIdRef.current = currentLeague?.id
    const [refreshing, setRefreshing] = useState(false)

    useEffect(() => {
        setTab(parseLeagueTab(params.tab))
    }, [params.tab])

    useEffect(() => {
        loadedTabs.current.clear()
        setStandings([])
        setTransactions([])
        setWaiverOrder([])
        setCurrentLeaguePicks([])
        setActiveDraft(null)
        setActivityOffset(0)
        setActivityHasMore(false)
        setActivityLoadingMore(false)
        setTabError({})
        setTabLoading({ standings: true })
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
                case 'standings': {
                    const data = await getLeagueStandings(lid)
                    commit = () => setStandings(data)
                    break
                }
                case 'activity': {
                    const data = await getLeagueTransactions(lid, ACTIVITY_LIMIT, 0)
                    commit = () => {
                        setTransactions(data)
                        setActivityOffset(0)
                        setActivityHasMore(data.length === ACTIVITY_LIMIT)
                    }
                    break
                }
                case 'waivers': {
                    const data = await getWaiverPriorityOrder(lid)
                    commit = () => setWaiverOrder(data)
                    break
                }
                case 'picks': {
                    const data = await getAllLeaguePicks(lid)
                    commit = () => setCurrentLeaguePicks(data)
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
    }, [])

    // On screen focus: fetch standings once, then fetch current tab if not loaded
    useFocusEffect(
        useCallback(() => {
            const lid = currentLeague?.id
            if (!lid) return
            if (!loadedTabs.current.has('standings')) {
                fetchTab('standings', lid)
            }
            if (tab !== 'standings' && !loadedTabs.current.has(tab)) {
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

    // Pull-to-refresh: clear loaded set, re-fetch current tab
    async function handleRefresh() {
        const lid = currentLeague?.id
        if (!lid) return
        setRefreshing(true)
        loadedTabs.current.clear()
        await Promise.all([fetchTab(tab, lid), fetchActiveDraft(lid)])
        setRefreshing(false)
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
        const isMock = draftMode === 'mock'
        confirmAction(
            isMock ? 'Start Mock Auction?' : 'Start Auction Draft?',
            isMock
                ? 'This starts a practice auction with no league, roster, or transaction side effects.'
                : 'This will begin the auction draft for all teams. This cannot be undone.',
            async () => {
                setDraftLoading(true)
                try {
                    const draft = await startDraft(currentLeague.id, nominationMode, {
                        isMock,
                        timerSeconds: draftTimerSeconds,
                    })
                    push({ pathname: '/(modals)/draft-room', params: { draftId: draft.id } })
                } catch (e: unknown) {
                    showAlert('Could not start draft', e instanceof Error ? e.message : undefined)
                } finally {
                    setDraftLoading(false)
                }
            },
            isMock ? 'Start Mock' : 'Start Draft',
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
        const isMock = draftMode === 'mock'
        confirmAction(
            isMock ? 'Start Mock Rookie Draft?' : 'Start Rookie Draft?',
            isMock
                ? 'This starts a practice rookie draft with no roster, pick-asset, or league-status side effects.'
                : 'This will begin the rookie snake draft. This cannot be undone.',
            async () => {
                setDraftLoading(true)
                try {
                    const result = await startRookieDraft(currentLeague.id, {
                        isMock,
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
            isMock ? 'Start Mock' : 'Start Draft',
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

    if (currentLeagueLoading || (!current && tabLoading.standings)) {
        return <LoadingScreen />
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

    function renderDraftActions() {
        if (activeDraftLoading) {
            return <ActivityIndicator color={colors.primary} />
        }

        if (activeDraft) {
            return (
                <>
                    <Pressable style={styles.draftButton} onPress={handleJoinDraftRoom} disabled={draftLoading}>
                        {draftLoading ? (
                            <ActivityIndicator size="small" color={colors.textWhite} />
                        ) : (
                            <Text style={styles.draftButtonText}>{activeDraftButtonLabel(activeDraft)}</Text>
                        )}
                    </Pressable>
                    {OPEN_DRAFT_STATUSES.has(activeDraft.status) && activeDraft.draftType === 'snake' && !activeDraft.isMock && isCommissioner ? (
                        <View style={styles.syncWrap}>
                            <Pressable style={styles.secondaryDraftButton} onPress={handleReseedRookiePicks} disabled={draftLoading}>
                                <Text style={styles.secondaryDraftButtonText}>Sync Traded Picks</Text>
                            </Pressable>
                            <Text style={styles.syncHint}>Commissioner only — pull in picks acquired via trade so the draft board is current.</Text>
                        </View>
                    ) : null}
                </>
            )
        }

        if (currentLeague?.status === 'setup' && isCommissioner) {
            return (
                <>
                    <Text style={styles.nominationModeLabel}>Draft mode</Text>
                    {renderDraftChips(DRAFT_MODE_CHIPS, draftMode, setDraftMode)}
                    <Text style={styles.nominationModeLabel}>Timer</Text>
                    {renderDraftChips(DRAFT_TIMER_CHIPS, draftTimerSeconds, setDraftTimerSeconds)}
                    <Text style={styles.nominationModeLabel}>Nomination order</Text>
                    {renderDraftChips(NOMINATION_ORDER_CHIPS, nominationMode, setNominationMode)}
                    <Pressable style={styles.draftButton} onPress={handleStartDraft} disabled={draftLoading}>
                        {draftLoading ? <ActivityIndicator size="small" color={colors.textWhite} /> : <Text style={styles.draftButtonText}>{draftMode === 'mock' ? 'Start Mock Auction' : 'Start Auction Draft'}</Text>}
                    </Pressable>
                </>
            )
        }

        if (currentLeague?.status === 'offseason' && isCommissioner) {
            return (
                <>
                    <Text style={styles.nominationModeLabel}>Draft mode</Text>
                    {renderDraftChips(DRAFT_MODE_CHIPS, draftMode, setDraftMode)}
                    <Text style={styles.nominationModeLabel}>Timer</Text>
                    {renderDraftChips(DRAFT_TIMER_CHIPS, draftTimerSeconds, setDraftTimerSeconds)}
                    <Text style={styles.nominationModeLabel}>Rookie rounds</Text>
                    {renderDraftChips(ROOKIE_ROUND_CHIPS, rookieRounds, setRookieRounds)}
                    <Text style={styles.nominationModeLabel}>Timeout behavior</Text>
                    {renderDraftChips(ROOKIE_TIMER_EXPIRY_CHIPS, rookieTimerExpiryBehavior, setRookieTimerExpiryBehavior)}
                    <Pressable style={styles.draftButton} onPress={handleStartRookieDraft} disabled={draftLoading}>
                        {draftLoading ? <ActivityIndicator size="small" color={colors.textWhite} /> : <Text style={styles.draftButtonText}>{draftMode === 'mock' ? 'Start Mock Rookie Draft' : 'Start Rookie Draft'}</Text>}
                    </Pressable>
                </>
            )
        }

        return null
    }

    function renderTabContent() {
        if (isTabLoading) {
            return <ActivityIndicator style={styles.loadingMargin} color={colors.primary} />
        }
        if (tabErr) {
            return (
                <Pressable
                    style={styles.errorBanner}
                    onPress={() => currentLeague?.id && fetchTab(tab, currentLeague.id)}
                >
                    <Text style={styles.errorBannerText}>Failed to load. Tap to retry.</Text>
                </Pressable>
            )
        }
        // The active tab's FlashList is the scroll container (so it virtualizes);
        // it owns pull-to-refresh via this RefreshControl.
        const refresh = (
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.primary} />
        )
        if (tab === 'standings') {
            return (
                <StandingsTable
                    standings={standings}
                    myMemberId={current?.id}
                    refreshControl={refresh}
                    onSelectTeam={(memberId, teamName) =>
                        push({ pathname: '/(modals)/team-roster', params: { memberId, teamName } })
                    }
                />
            )
        }
        if (tab === 'activity') {
            return (
                <ActivityFeed
                    transactions={transactions}
                    myMemberId={current?.id}
                    refreshControl={refresh}
                    onLoadMore={handleLoadMoreActivity}
                    hasMore={activityHasMore && !activityLoadingMore}
                />
            )
        }
        if (tab === 'waivers') {
            return <WaiverPriorityList rows={waiverOrder} myMemberId={current?.id} refreshControl={refresh} />
        }
        return <PicksBankList picks={currentLeaguePicks} myMemberId={current?.id} refreshControl={refresh} />
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
                    <View style={styles.headerButtons}>
                        <Pressable
                            style={styles.settingsButton}
                            onPress={() => push('/(modals)/bracket')}
                        >
                            <Text style={styles.settingsButtonText}>Bracket</Text>
                        </Pressable>
                        {isCommissioner ? (
                            <Pressable
                                style={styles.settingsButton}
                                onPress={() => push('/(modals)/commissioner-settings')}
                            >
                                <Text style={styles.settingsButtonText}>Settings</Text>
                            </Pressable>
                        ) : null}
                    </View>
                </View>

                {/* Invite code */}
                <Pressable
                    style={styles.inviteRow}
                    onPress={shareInviteCode}
                >
                    <Text style={styles.inviteLabel}>Invite Code</Text>
                    <Text style={styles.inviteCode}>{currentLeague?.invite_code}</Text>
                    <Text style={styles.inviteCopy}>Share</Text>
                </Pressable>

                {/* Draft actions */}
                {renderDraftActions()}
            </View>

            {/* Tab switcher — wraps to a second row on narrow widths so every pill
                stays reachable (no horizontal clip at 320). */}
            <View style={styles.tabRow}>
                {(['standings', 'activity', 'waivers', 'picks'] as Tab[]).map((t) => (
                    <Pressable
                        key={t}
                        style={[styles.tabChip, tab === t && styles.tabChipActive]}
                        onPress={() => handleTabChange(t)}
                    >
                        <Text style={[styles.tabChipText, tab === t && styles.tabChipTextActive]}>
                            {t === 'standings' ? 'Standings'
                                : t === 'activity' ? 'Activity'
                                : t === 'waivers' ? 'Waivers'
                                : 'Picks'}
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
    loadingMargin: { marginTop: spacing['3xl'] },

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
        letterSpacing: 0.5,
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
    inviteCode: { flexShrink: 1, fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: colors.textPrimary, letterSpacing: 1 },
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
