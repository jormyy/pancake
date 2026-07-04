import {
    View,
    Text,
    Pressable,
    Platform,
    StyleSheet,
    useWindowDimensions,
} from 'react-native'
import { useEffect, useState, type ComponentProps } from 'react'
import { SafeAreaView } from 'react-native-safe-area-context'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { colors, fontSize, fontWeight, radii, spacing, layout } from '@/constants/tokens'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ui'
import { NoLeagueState } from '@/components/NoLeagueState'
import { StandingsTable } from '@/components/league/LeagueStandings'
import { ActivityFeed } from '@/components/league/LeagueActivityFeed'
import { AuctionPanel, DraftBoardPanel } from '@/components/league/DraftSetupPanels'
import { MockRoomsPanel } from '@/components/league/MockRoomsPanel'
import { SettingsPanel } from '@/components/league/SettingsPanel'
import { LeagueTabBar } from '@/components/league/LeagueTabBar'
import { useLeagueScreenState } from '@/hooks/use-league-screen-state'
import { LEAGUE_TABS } from '@/lib/league/tabs'
import type { LeagueStatus } from '@/types/database'

type PhaseStep = {
    key: 'setup' | 'drafting' | 'season' | 'offseason'
    label: string
    icon: ComponentProps<typeof MaterialIcons>['name']
}

const PHASE_STEPS: readonly PhaseStep[] = [
    { key: 'setup', label: 'Setup', icon: 'tune' },
    { key: 'drafting', label: 'Draft', icon: 'gavel' },
    { key: 'season', label: 'Season', icon: 'sports-basketball' },
    { key: 'offseason', label: 'Offseason', icon: 'event-repeat' },
]

const LEAGUE_TAB_LABELS = Object.fromEntries(
    LEAGUE_TABS.map((tab) => [tab.key, tab.label]),
) as Record<(typeof LEAGUE_TABS)[number]['key'], string>

const STATUS_COPY: Record<LeagueStatus, { label: string; stepLabel: string; detail: string; activeStep: PhaseStep['key'] }> = {
    setup: {
        label: 'Pre-draft',
        stepLabel: 'Pre-draft',
        detail: 'Standings and draft assets stay visible before the clock starts.',
        activeStep: 'setup',
    },
    drafting: {
        label: 'Drafting',
        stepLabel: 'Drafting',
        detail: 'The draft room is live; league navigation remains available as rosters come together.',
        activeStep: 'drafting',
    },
    active: {
        label: 'Regular season',
        stepLabel: 'Season',
        detail: 'Matchups and standings update as games score and weeks finalize.',
        activeStep: 'season',
    },
    playoffs: {
        label: 'Playoffs',
        stepLabel: 'Playoffs',
        detail: 'The season table stays intact while bracket results decide the champion.',
        activeStep: 'season',
    },
    offseason: {
        label: 'Offseason',
        stepLabel: 'Offseason',
        detail: 'Review results, trade picks, and prep the rookie draft.',
        activeStep: 'offseason',
    },
    archived: {
        label: 'Archived',
        stepLabel: 'Archived',
        detail: 'This league is read-only history.',
        activeStep: 'offseason',
    },
}

function phaseStepState(index: number, activeIndex: number) {
    if (index < activeIndex) return 'complete'
    if (index === activeIndex) return 'current'
    return 'upcoming'
}

function phaseStepDisplayLabel(step: PhaseStep, phase: { label: string; stepLabel: string }, isActive: boolean) {
    if (!isActive) return step.label
    return phase.stepLabel
}

function LeaguePhaseRail({ status, compact = false }: { status?: LeagueStatus; compact?: boolean }) {
    const phase = STATUS_COPY[status ?? 'setup']
    const activeIndex = PHASE_STEPS.findIndex((step) => step.key === phase.activeStep)
    const stepCount = PHASE_STEPS.length
    const activeStepPosition = activeIndex + 1
    const phaseLabel = `League phase: ${phase.label}, step ${activeStepPosition} of ${stepCount}. ${phase.detail}`

    return (
        <View
            style={[styles.phaseWrap, compact && styles.phaseWrapCompact]}
            role="group"
            aria-label={phaseLabel}
            aria-live="polite"
            accessibilityLabel={phaseLabel}
            accessibilityLiveRegion="polite"
        >
            {compact ? (
                <View style={styles.phaseCompactSummary}>
                    <Text style={styles.phaseCompactLabel} numberOfLines={1}>
                        {phase.label}
                    </Text>
                    <Text style={styles.phaseCompactDetail} numberOfLines={1}>
                        {phase.detail}
                    </Text>
                </View>
            ) : (
                <View style={styles.phaseTop}>
                    <View style={styles.statusPill}>
                        <Text style={styles.statusPillText}>{phase.label}</Text>
                    </View>
                    <Text style={styles.phaseDetail}>{phase.detail}</Text>
                </View>
            )}
            <View
                style={styles.phaseRail}
                role="list"
                aria-label={`League lifecycle, ${stepCount} steps`}
                accessibilityRole="list"
                accessibilityLabel={`League lifecycle, ${stepCount} steps`}
            >
                {PHASE_STEPS.map((step, index) => {
                    const isActive = index === activeIndex
                    const isComplete = index < activeIndex
                    const state = phaseStepState(index, activeIndex)
                    const stepPosition = index + 1
                    const stepLabel = phaseStepDisplayLabel(step, phase, isActive)
                    const accessibilityLabel = isActive
                        ? `${stepLabel} phase, current step ${stepPosition} of ${stepCount}, ${phase.label}`
                        : `${step.label} phase, ${state}, step ${stepPosition} of ${stepCount}`
                    return (
                        <View
                            key={step.key}
                            style={[styles.phaseStep, compact && styles.phaseStepCompact, isActive && styles.phaseStepActive]}
                            role="listitem"
                            aria-current={isActive ? 'step' : undefined}
                            aria-label={accessibilityLabel}
                            accessibilityRole="text"
                            accessibilityLabel={accessibilityLabel}
                        >
                            <MaterialIcons
                                name={step.icon}
                                size={15}
                                color={isActive || isComplete ? colors.primaryDark : colors.textMuted}
                                aria-hidden
                                accessibilityElementsHidden
                                importantForAccessibility="no-hide-descendants"
                            />
                            <Text
                                style={[styles.phaseStepText, (isActive || isComplete) && styles.phaseStepTextActive]}
                                numberOfLines={1}
                            >
                                {stepLabel}
                            </Text>
                        </View>
                    )
                })}
            </View>
        </View>
    )
}

export default function LeagueScreen() {
    const screen = useLeagueScreenState()
    const { width, height } = useWindowDimensions()
    const [webViewport, setWebViewport] = useState<{ width: number; height: number } | null>(null)
    const viewportWidth = Platform.OS === 'web' && webViewport !== null ? webViewport.width : width
    const viewportHeight = Platform.OS === 'web' && webViewport !== null ? webViewport.height : height
    const compactLandscape = viewportWidth >= 600 && viewportHeight < 500
    const compactShortPortrait = viewportWidth < 380 && viewportHeight < 760
    const compactLeagueHeader = compactLandscape || compactShortPortrait
    const activePanelId = `league-panel-${screen.tab}`
    const activeTabId = `league-tab-${screen.tab}`
    const activeTabLabel = LEAGUE_TAB_LABELS[screen.tab]

    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return
        const syncViewport = () => setWebViewport({ width: window.innerWidth, height: window.innerHeight })
        syncViewport()
        window.addEventListener('resize', syncViewport)
        return () => window.removeEventListener('resize', syncViewport)
    }, [])

    if (!screen.current) {
        if (screen.leagueLoading) {
            return (
                <EmptyState
                    message="Loading league..."
                    description="Fetching your teams and league settings."
                    icon="sync"
                />
            )
        }
        return <NoLeagueState />
    }

    const currentLeagueName = screen.currentLeague?.name ?? 'League'
    const currentTeamName = screen.current.team_name ?? 'Team'
    const compactIdentityLabel = `${currentLeagueName}, ${currentTeamName}`

    function renderTabContent() {
        if (screen.tabErr && !screen.isTabLoading) {
            return (
                <ErrorBanner
                    message={`${activeTabLabel} could not load. Select to retry.`}
                    onRetry={screen.retryCurrentTab}
                />
            )
        }

        if (screen.tab === 'results') {
            return (
                <StandingsTable
                    standings={screen.standings}
                    leagueStatus={screen.currentLeague?.status}
                    loading={screen.isTabLoading}
                    myMemberId={screen.current?.id}
                    onSelectTeam={screen.openTeamRoster}
                    onOpenBracket={screen.openBracket}
                />
            )
        }

        if (screen.tab === 'auctions') {
            return (
                <AuctionPanel
                    activeDraft={screen.activeDraft}
                    activeDraftLoading={screen.activeDraftLoading}
                    currentLeagueStatus={screen.currentLeague?.status}
                    isCommissioner={screen.isCommissioner}
                    draftLoading={screen.draftLoading}
                    activeDraftError={screen.activeDraftError}
                    onRetryActiveDraft={screen.retryActiveDraft}
                    nominationMode={screen.nominationMode}
                    onNominationModeChange={screen.setNominationMode}
                    draftTimerSeconds={screen.draftTimerSeconds}
                    onDraftTimerSecondsChange={screen.setDraftTimerSeconds}
                    onStartDraft={screen.handleStartDraft}
                    onJoinDraft={screen.handleJoinDraftRoom}
                    onReseedRookiePicks={screen.handleReseedRookiePicks}
                    onOpenDraftBoard={() => screen.handleTabChange('draftBoard')}
                />
            )
        }

        if (screen.tab === 'mockRooms') {
            return (
                <MockRoomsPanel
                    roomName={screen.roomName}
                    onRoomNameChange={screen.setRoomName}
                    roomDraftType={screen.roomDraftType}
                    onRoomDraftTypeChange={screen.setRoomDraftType}
                    roomScheduledAt={screen.roomScheduledAt}
                    onRoomScheduledAtChange={screen.setRoomScheduledAt}
                    roomSubmitting={screen.roomSubmitting}
                    draftLoading={screen.draftLoading}
                    rooms={screen.mockRooms}
                    nominationMode={screen.nominationMode}
                    onNominationModeChange={screen.setNominationMode}
                    draftTimerSeconds={screen.draftTimerSeconds}
                    onDraftTimerSecondsChange={screen.setDraftTimerSeconds}
                    rookieRounds={screen.rookieRounds}
                    onRookieRoundsChange={screen.setRookieRounds}
                    rookieTimerExpiryBehavior={screen.rookieTimerExpiryBehavior}
                    onRookieTimerExpiryBehaviorChange={screen.setRookieTimerExpiryBehavior}
                    onCreateRoom={screen.handleCreateMockRoom}
                    onOpenRoom={screen.openDraftRoom}
                    onJoinRoom={screen.handleJoinMockRoom}
                    onLeaveRoom={screen.handleLeaveMockRoom}
                    onStartRoom={screen.handleStartMockRoom}
                />
            )
        }

        if (screen.tab === 'draftBoard') {
            return (
                <DraftBoardPanel
                    activeDraft={screen.activeDraft}
                    activeDraftLoading={screen.activeDraftLoading}
                    currentLeagueStatus={screen.currentLeague?.status}
                    isCommissioner={screen.isCommissioner}
                    draftLoading={screen.draftLoading}
                    activeDraftError={screen.activeDraftError}
                    onRetryActiveDraft={screen.retryActiveDraft}
                    picks={screen.currentLeaguePicks}
                    picksLoading={screen.isTabLoading}
                    myMemberId={screen.current?.id}
                    draftTimerSeconds={screen.draftTimerSeconds}
                    onDraftTimerSecondsChange={screen.setDraftTimerSeconds}
                    rookieRounds={screen.rookieRounds}
                    onRookieRoundsChange={screen.setRookieRounds}
                    rookieTimerExpiryBehavior={screen.rookieTimerExpiryBehavior}
                    onRookieTimerExpiryBehaviorChange={screen.setRookieTimerExpiryBehavior}
                    onStartRookieDraft={screen.handleStartRookieDraft}
                    onJoinDraft={screen.handleJoinDraftRoom}
                    onReseedRookiePicks={screen.handleReseedRookiePicks}
                />
            )
        }

        if (screen.tab === 'settings') {
            return (
                <SettingsPanel
                    inviteCode={screen.currentLeague?.invite_code}
                    isCommissioner={screen.isCommissioner}
                    waiverOrder={screen.waiverOrder}
                    myMemberId={screen.current?.id}
                    onShareInviteCode={screen.shareInviteCode}
                    onOpenBracket={screen.openBracket}
                    onOpenCommissionerSettings={screen.openCommissionerSettings}
                />
            )
        }

        return (
            <ActivityFeed
                transactions={screen.transactions}
                myMemberId={screen.current?.id}
                onLoadMore={screen.handleLoadMoreActivity}
                hasMore={screen.activityHasMore && !screen.activityLoadingMore}
                loading={screen.isTabLoading}
                loadingMore={screen.activityLoadingMore}
                loadMoreError={screen.activityLoadMoreError}
            />
        )
    }

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.contentWrap}>
                <View style={[styles.header, compactLeagueHeader && styles.headerCompact]}>
                    {compactLeagueHeader ? (
                        <View
                            style={styles.compactLeagueCrumb}
                            role="group"
                            aria-label={compactIdentityLabel}
                            accessibilityRole="text"
                            accessibilityLabel={compactIdentityLabel}
                        >
                            <Text
                                style={styles.compactLeagueName}
                                numberOfLines={1}
                                role="heading"
                                aria-level={1}
                            >
                                {currentLeagueName}
                            </Text>
                            <View
                                style={styles.compactLeagueDot}
                                aria-hidden
                                accessibilityElementsHidden
                                importantForAccessibility="no-hide-descendants"
                            />
                            <Text style={styles.compactTeamName} numberOfLines={1}>
                                {currentTeamName}
                            </Text>
                        </View>
                    ) : (
                        <View style={styles.headerTop}>
                            <View style={styles.headerInfo}>
                                <Text
                                    style={styles.currentLeagueName}
                                    numberOfLines={2}
                                    role="heading"
                                    aria-level={1}
                                >
                                    {currentLeagueName}
                                </Text>
                                <Text style={styles.teamName} numberOfLines={1}>
                                    {currentTeamName}
                                </Text>
                            </View>
                        </View>
                    )}
                    <LeaguePhaseRail status={screen.currentLeague?.status} compact={compactLeagueHeader} />
                </View>

                <LeagueTabBar activeTab={screen.tab} onTabChange={screen.handleTabChange} />
                <View
                    nativeID={activePanelId}
                    style={styles.contentScroll}
                    role="tabpanel"
                    aria-label={`${activeTabLabel} league section`}
                    aria-labelledby={activeTabId}
                    accessibilityLabel={`${activeTabLabel} league section`}
                >
                    {renderTabContent()}
                </View>
            </View>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    contentWrap: { flex: 1, width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center' },
    header: { padding: spacing['2xl'], borderBottomWidth: 1, borderBottomColor: colors.borderLight, gap: spacing.lg },
    headerCompact: { paddingVertical: spacing.sm, gap: spacing.sm },
    headerTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.lg },
    headerInfo: { flex: 1, minWidth: 0, gap: spacing.xxs },
    currentLeagueName: { fontSize: fontSize.xl, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    teamName: { fontSize: fontSize.md, color: colors.textMuted },
    compactLeagueCrumb: {
        minHeight: 24,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    compactLeagueName: {
        flex: 1.2,
        minWidth: 0,
        color: colors.textPrimary,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.extrabold,
    },
    compactLeagueDot: {
        width: 4,
        height: 4,
        borderRadius: 2,
        backgroundColor: colors.border,
    },
    compactTeamName: {
        flex: 1,
        minWidth: 0,
        color: colors.textSecondary,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.medium,
    },
    phaseWrap: {
        gap: spacing.md,
        padding: spacing.lg,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    phaseWrapCompact: { gap: spacing.xs, padding: spacing.sm },
    phaseCompactSummary: {
        minHeight: 20,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    phaseCompactLabel: {
        color: colors.primaryDark,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        textTransform: 'uppercase',
        letterSpacing: 0,
    },
    phaseCompactDetail: {
        flex: 1,
        minWidth: 0,
        color: colors.textSecondary,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.medium,
    },
    phaseTop: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: spacing.md,
    },
    statusPill: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderRadius: radii.full,
        backgroundColor: colors.primaryLight,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
    },
    statusPillText: {
        color: colors.primaryDark,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        textTransform: 'uppercase',
        letterSpacing: 0,
    },
    phaseDetail: {
        flex: 1,
        minWidth: 220,
        color: colors.textSecondary,
        fontSize: fontSize.sm,
        lineHeight: 18,
    },
    phaseRail: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
    },
    phaseStep: {
        flexGrow: 1,
        flexBasis: 72,
        minHeight: 48,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.xxs,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgSubtle,
        borderWidth: 1,
        borderColor: colors.borderLight,
    },
    // Compact: icon + label side by side in a short strip so the phase rail
    // costs one slim line instead of a 44px tile row on small phones.
    phaseStepCompact: {
        minHeight: 26,
        flexBasis: 64,
        flexDirection: 'row',
        gap: spacing.xs,
        paddingHorizontal: spacing.xs,
    },
    phaseStepActive: {
        backgroundColor: colors.successLight,
        borderColor: colors.success,
    },
    phaseStepText: {
        color: colors.textMuted,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
    },
    phaseStepTextActive: { color: colors.primaryDark },
    contentScroll: { flex: 1 },
})
