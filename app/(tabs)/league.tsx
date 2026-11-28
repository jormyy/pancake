import { useEffect } from 'react'
import { sessionOwner } from '@/lib/session-cache-registry'
import { useScreenView } from '@/hooks/use-screen-view'
import { screenScope } from '@/lib/cache/screen-scope'
import type { RosterView } from '@/lib/cache/view-types'
import { ScreenStatusOverlay, ScreenStatusProvider } from '@/components/ui/ScreenStatusOverlay'
import { DeferredContent } from '@/components/ui/DeferredContent'
import { View, Text, StyleSheet } from 'react-native'
import { colors, spacing, typeScale } from '@/constants/tokens'
import { ErrorBanner, Page, PageHeader, SegmentedControl } from '@/components/ui'
import { NoLeagueState } from '@/components/NoLeagueState'
import { StandingsTable } from '@/components/league/LeagueStandings'
import { LeaguePlayoffs } from '@/components/league/LeaguePlayoffs'
import { LeagueHistory } from '@/components/league/LeagueHistory'
import { ActivityFeed } from '@/components/league/LeagueActivityFeed'
import { DraftPanel } from '@/components/league/DraftSetupPanels'
import { MockRoomsPanel } from '@/components/league/MockRoomsPanel'
import { SettingsPanel } from '@/components/league/SettingsPanel'
import { LeagueMoreCard } from '@/components/league/LeagueMoreCard'
import { LeagueTabSkeleton } from '@/components/league/LeagueTabSkeleton'
import { prefetchLeagueViews } from '@/components/league/prefetchLeagueViews'
import { useLeagueScreenState } from '@/hooks/use-league-screen-state'
import { LeagueSchedule } from '@/components/league/LeagueSchedule'
import { PicksBankList } from '@/components/league/LeaguePicksBank'
import { LEAGUE_TABS, type LeagueSection } from '@/lib/league/tabs'

const LEAGUE_TAB_LABELS = Object.fromEntries(
    LEAGUE_TABS.map((tab) => [tab.key, tab.label]),
) as Record<(typeof LEAGUE_TABS)[number]['key'], string>

const PRIMARY_TABS: readonly { value: LeagueSection; label: string }[] = [
    { value: 'results', label: 'Standings' },
    { value: 'schedule', label: 'Schedule' },
    { value: 'bracket', label: 'Playoffs' },
]

function isPrimarySection(tab: LeagueSection) {
    return PRIMARY_TABS.some((option) => option.value === tab)
}

function LeagueScreen() {
    const screen = useLeagueScreenState()
    const lockView = useScreenView<RosterView>(screen.tab === 'picks' && screen.current && screen.currentLeague && sessionOwner()
        ? screenScope('roster', screen.currentLeague.id, screen.current.id, {}, sessionOwner()!) : null)
    const leagueId = screen.currentLeague?.id
    const memberId = screen.current?.id
    useEffect(() => {
        if (leagueId && memberId) prefetchLeagueViews(leagueId, memberId)
    }, [leagueId, memberId])
    const primary = isPrimarySection(screen.tab)
    const activePanelId = `league-panel-${screen.tab}`
    const activeTabId = `league-tab-${screen.tab}`
    const activeTabLabel = LEAGUE_TAB_LABELS[screen.tab]

    if (!screen.current) {
        // No placeholder shell while the league context loads — the screen
        // stays blank and the real UI appears fully formed, with no reflow.
        if (screen.leagueLoading) {
            return <View style={styles.container} />
        }
        return <NoLeagueState />
    }

    function renderTabContent() {
        if (screen.tab === 'results') {
            return (
                <StandingsTable
                    playoffEntrants={screen.currentLeague?.playoff_entrants}
                    standings={screen.standings}
                    leagueStatus={screen.currentLeague?.status}
                    loading={screen.isTabLoading}
                    myMemberId={screen.current?.id}
                    onSelectTeam={screen.openTeamRoster}
                    onOpenBracket={screen.openBracket}
                    footer={<LeagueMoreCard activeTab={screen.tab} onSelect={screen.handleTabChange} />}
                />
            )
        }

        if (screen.tab === 'bracket') return <LeaguePlayoffs key={screen.currentLeague?.id} standings={screen.standings} playoffEntrants={screen.currentLeague?.playoff_entrants} />

        if (screen.tab === 'seasons') {
            return <LeagueHistory key={screen.currentLeague?.id} seasons={screen.seasons} trades={screen.trades} tradeCounts={screen.tradeCounts} onRefresh={screen.retryCurrentTab} refreshing={screen.isTabRefreshing} />
        }

        if (screen.tab === 'draft') {
            return (
                <DraftPanel
                    activeDraft={screen.activeDraft}
                    activeDraftLoading={screen.activeDraftLoading && !screen.activeDraftLoaded}
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
                    rookieRounds={screen.rookieRounds}
                    onRookieRoundsChange={screen.setRookieRounds}
                    rookieTimerExpiryBehavior={screen.rookieTimerExpiryBehavior}
                    onRookieTimerExpiryBehaviorChange={screen.setRookieTimerExpiryBehavior}
                    onStartRookieDraft={screen.handleStartRookieDraft}
                >
                    <MockRoomsPanel
                        embedded
                        roomName={screen.roomName}
                        onRoomNameChange={screen.setRoomName}
                        roomDraftType={screen.roomDraftType}
                        onRoomDraftTypeChange={screen.setRoomDraftType}
                        roomScheduledAt={screen.roomScheduledAt}
                        onRoomScheduledAtChange={screen.setRoomScheduledAt}
                        roomSubmitting={screen.roomSubmitting}
                        draftLoading={screen.draftLoading}
                        rooms={screen.mockRooms}
                        nominationMode={screen.mockNominationMode}
                        onNominationModeChange={screen.setMockNominationMode}
                        draftTimerSeconds={screen.mockDraftTimerSeconds}
                        onDraftTimerSecondsChange={screen.setMockDraftTimerSeconds}
                        rookieRounds={screen.mockRookieRounds}
                        onRookieRoundsChange={screen.setMockRookieRounds}
                        rookieTimerExpiryBehavior={screen.mockRookieTimerExpiryBehavior}
                        onRookieTimerExpiryBehaviorChange={screen.setMockRookieTimerExpiryBehavior}
                        onCreateRoom={screen.handleCreateMockRoom}
                        onOpenRoom={screen.openDraftRoom}
                        onJoinRoom={screen.handleJoinMockRoom}
                        onLeaveRoom={screen.handleLeaveMockRoom}
                        onStartRoom={screen.handleStartMockRoom}
                        onDeleteRoom={screen.handleDeleteMockRoom}
                    />
                </DraftPanel>
            )
        }

        if (screen.tab === 'picks') {
            return (
                <PicksBankList
                    picks={screen.currentLeaguePicks}
                    locks={lockView.data?.lockedAssets}
                    loading={screen.isTabLoading}
                    myMemberId={screen.current?.id}
                />
            )
        }

        if (screen.tab === 'schedule') return <LeagueSchedule rows={screen.schedule} onOpenMatchup={screen.openMatchup} />

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
                onRefresh={screen.retryCurrentTab}
                refreshing={screen.isTabRefreshing}
                hasMore={screen.activityHasMore && !screen.activityLoadingMore}
                loading={screen.isTabLoading}
                loadingMore={screen.activityLoadingMore}
                loadMoreError={screen.activityLoadMoreError}
            />
        )
    }

    // The league switcher already names the league and team, so the page
    // leads with its sections. Standings, Schedule and Playoffs stay one tap
    // away; every other view opens from the More card and returns here.
    return (
        <Page title="League">
            <PageHeader
                title={primary ? undefined : activeTabLabel}
                showTitle={!primary}
                onBack={primary ? undefined : () => screen.handleTabChange('results')}
                backLabel="League sections"
                tabs={primary ? (
                    <SegmentedControl
                        variant="tabs"
                        equalWidth
                        value={screen.tab}
                        onChange={screen.handleTabChange}
                        options={PRIMARY_TABS.map((tab) => ({ label: tab.label, value: tab.value }))}
                        accessibilityLabel="League sections"
                        idBase="league-tab"
                        controlledPanelId={activePanelId}
                        style={styles.tabs}
                    />
                ) : undefined}
            />
            <View
                nativeID={activePanelId}
                style={styles.panel}
                role="tabpanel"
                aria-label={`${activeTabLabel} league section`}
                aria-labelledby={primary ? activeTabId : undefined}
                accessibilityLabel={`${activeTabLabel} league section`}
            >
                <DeferredContent key={screen.tab} ready={screen.isTabLoaded && (screen.tab !== 'draft' || screen.activeDraftLoaded)} busy={screen.isTabRefreshing || screen.isTabLoading} fallback={<LeagueTabSkeleton label={activeTabLabel} />}>{renderTabContent()}</DeferredContent>
            </View>
            <ScreenStatusOverlay>
                {screen.tab !== 'draft' && screen.isTabLoaded && !screen.isOnline ? (
                    <Text style={styles.freshness} accessibilityLiveRegion="polite">
                        {`Offline. Showing saved ${activeTabLabel} data.`}
                    </Text>
                ) : screen.tabErr && !screen.isTabLoading ? (
                    <ErrorBanner
                        message={screen.isTabLoaded
                            ? `${activeTabLabel} refresh failed. Showing saved data. Select to retry.`
                            : `${activeTabLabel} could not load. Select to retry.`}
                        onRetry={screen.retryCurrentTab}
                    />
                ) : null}
            </ScreenStatusOverlay>
        </Page>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    freshness: { ...typeScale.small, color: colors.textSecondary, padding: spacing.md },
    panel: { flex: 1, minHeight: 0 },
    tabs: { flexWrap: 'nowrap' },
})

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

export default function LeagueScreenWithStatus() {
    return <ScreenStatusProvider><LeagueScreen /></ScreenStatusProvider>
}
