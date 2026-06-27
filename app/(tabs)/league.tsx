import {
    View,
    Text,
    ScrollView,
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
    getActiveDraft,
    startDraft,
    NOMINATION_ORDER_MODES,
    NOMINATION_ORDER_MODE_LABELS,
    type NominationOrderMode,
} from '@/lib/draft'
import { getWaiverPriorityOrder, WaiverPriorityRow } from '@/lib/waivers'
import { getLeagueTransactions, TransactionRow } from '@/lib/transactions'
import { getActiveRookieDraft, startRookieDraft, getAllLeaguePicks, reseedRookieDraftPicks, LeaguePickItem } from '@/lib/rookieDraft'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { LoadingScreen } from '@/components/LoadingScreen'
import { EmptyState } from '@/components/EmptyState'
import { StandingsTable, ActivityFeed, WaiverPriorityList, PicksBankList } from '@/components/league/LeagueSections'
import { confirmAction, showAlert } from '@/lib/alert'

type Tab = 'standings' | 'activity' | 'waivers' | 'picks'

const ACTIVITY_LIMIT = 50

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
        setActivityOffset(0)
        setActivityHasMore(false)
        setActivityLoadingMore(false)
        setTabError({})
        setTabLoading({ standings: true })
    }, [currentLeague?.id])

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
        }, [currentLeague?.id, tab, fetchTab]),
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
        await fetchTab(tab, lid)
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
        confirmAction(
            'Start Auction Draft?',
            'This will begin the auction draft for all teams. This cannot be undone.',
            async () => {
                setDraftLoading(true)
                try {
                    const draft = await startDraft(currentLeague.id, nominationMode)
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
            const draft = await getActiveDraft(currentLeague.id)
            if (!draft) {
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
                    const result = await startRookieDraft(currentLeague.id)
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

    async function handleJoinRookieDraft() {
        if (!currentLeague?.id) return
        setDraftLoading(true)
        try {
            const draft = await getActiveRookieDraft(currentLeague.id)
            if (!draft) {
                showAlert('No active rookie draft found')
                return
            }
            push({ pathname: '/(modals)/rookie-draft-room', params: { draftId: draft.id } })
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
            {/* Header */}
            <View style={styles.header}>
                <View style={styles.headerTop}>
                    <View style={styles.headerInfo}>
                        <Text style={styles.currentLeagueName}>{currentLeague?.name}</Text>
                        <Text style={styles.teamName}>{current.team_name}</Text>
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
                {currentLeague?.status === 'setup' && isCommissioner ? (
                    <>
                        <Text style={styles.nominationModeLabel}>Nomination order</Text>
                        <View style={styles.nominationModeRow}>
                            {NOMINATION_ORDER_MODES.map((mode) => {
                                const selected = nominationMode === mode
                                return (
                                    <Pressable
                                        key={mode}
                                        style={[styles.nominationModeChip, selected && styles.nominationModeChipOn]}
                                        onPress={() => setNominationMode(mode)}
                                        accessibilityRole="button"
                                        accessibilityState={{ selected }}
                                    >
                                        <Text style={[styles.nominationModeChipText, selected && styles.nominationModeChipTextOn]}>
                                            {NOMINATION_ORDER_MODE_LABELS[mode]}
                                        </Text>
                                    </Pressable>
                                )
                            })}
                        </View>
                        <Pressable style={styles.draftButton} onPress={handleStartDraft} disabled={draftLoading}>
                            {draftLoading ? <ActivityIndicator size="small" color={colors.textWhite} /> : <Text style={styles.draftButtonText}>Start Auction Draft</Text>}
                        </Pressable>
                    </>
                ) : null}
                {currentLeague?.status === 'drafting' ? (
                    <Pressable style={styles.draftButton} onPress={handleJoinDraftRoom} disabled={draftLoading}>
                        {draftLoading ? <ActivityIndicator size="small" color={colors.textWhite} /> : <Text style={styles.draftButtonText}>Join Draft Room</Text>}
                    </Pressable>
                ) : null}
                {currentLeague?.status === 'drafting' && isCommissioner ? (
                    <Pressable style={[styles.draftButton, { backgroundColor: colors.bgSubtle, borderWidth: 1, borderColor: colors.border, marginTop: 8 }]} onPress={handleReseedRookiePicks} disabled={draftLoading}>
                        <Text style={[styles.draftButtonText, { color: colors.textSecondary }]}>Fix Traded Pick Slots</Text>
                    </Pressable>
                ) : null}
                {currentLeague?.status === 'offseason' && isCommissioner ? (
                    <Pressable style={styles.draftButton} onPress={handleStartRookieDraft} disabled={draftLoading}>
                        {draftLoading ? <ActivityIndicator size="small" color={colors.textWhite} /> : <Text style={styles.draftButtonText}>Start Rookie Draft</Text>}
                    </Pressable>
                ) : null}
                {currentLeague?.status === 'offseason' && !isCommissioner ? (
                    <Pressable style={styles.draftButton} onPress={handleJoinRookieDraft} disabled={draftLoading}>
                        {draftLoading ? <ActivityIndicator size="small" color={colors.textWhite} /> : <Text style={styles.draftButtonText}>Join Rookie Draft</Text>}
                    </Pressable>
                ) : null}
            </View>

            {/* Tab switcher */}
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.tabRow}
                contentContainerStyle={styles.tabRowContent}
            >
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
            </ScrollView>

            {/* Tab content — each tab's FlashList is the scroll container so it
                virtualizes (no wrapping vertical ScrollView). */}
            <View style={styles.contentScroll}>{renderTabContent()}</View>
        </SafeAreaView>
    )
}


const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    loadingMargin: { marginTop: spacing['3xl'] },

    header: { padding: spacing['2xl'], borderBottomWidth: 1, borderBottomColor: colors.borderLight, gap: spacing.lg },
    headerTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.lg },
    headerInfo: { flex: 1, gap: spacing.xxs },
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
    nominationModeLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: spacing.xs,
    },
    nominationModeRow: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.sm },
    nominationModeChip: {
        flex: 1,
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
    inviteCode: { fontSize: 15, fontWeight: fontWeight.extrabold, color: colors.textPrimary, letterSpacing: 2 },
    inviteCopy: { fontSize: fontSize.sm, color: colors.primaryDark, fontWeight: fontWeight.semibold },

    tabRow: {
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        flexGrow: 0,
        flexShrink: 0,
    },
    tabRowContent: {
        flexDirection: 'row',
        gap: spacing.md,
        paddingLeft: spacing['2xl'],
        paddingRight: spacing['4xl'],
        paddingVertical: spacing.lg,
    },
    tabChip: {
        paddingHorizontal: 14,
        paddingVertical: 7,
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
