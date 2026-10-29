import { ScreenStatusOverlay, ScreenStatusProvider } from '@/components/ui/ScreenStatusOverlay'
import { DeferredContent } from '@/components/ui/DeferredContent'
import { View, Text, StyleSheet } from 'react-native'
import { colors, fontSize, spacing } from '@/constants/tokens'
import { ErrorBanner, Page, PageHeader, SegmentedControl } from '@/components/ui'
import { NoLeagueState } from '@/components/NoLeagueState'
import { StandingsTable } from '@/components/league/LeagueStandings'
import { ActivityFeed } from '@/components/league/LeagueActivityFeed'
import { DraftPanel } from '@/components/league/DraftSetupPanels'
import { MockRoomsPanel } from '@/components/league/MockRoomsPanel'
import { SettingsPanel } from '@/components/league/SettingsPanel'
import { useLeagueScreenState } from '@/hooks/use-league-screen-state'
import { LeagueSchedule } from '@/components/league/LeagueSchedule'
import { PicksBankList } from '@/components/league/LeaguePicksBank'
import { LEAGUE_TABS } from '@/lib/league/tabs'

const LEAGUE_TAB_LABELS = Object.fromEntries(
    LEAGUE_TABS.map((tab) => [tab.key, tab.label]),
) as Record<(typeof LEAGUE_TABS)[number]['key'], string>


function LeagueScreen() {
    const screen = useLeagueScreenState()
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
        // Tab panels render only once their data is known, so content appears
        // fully formed instead of loading in pieces that shift the layout.
        if (!screen.isTabLoaded) return null
        if (screen.tab === 'draft' && !screen.activeDraftLoaded) {
            return null
        }

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
                />
            )
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
                    loading={screen.isTabLoading}
                    myMemberId={screen.current?.id}
                />
            )
        }

        if (screen.tab === 'schedule') return <LeagueSchedule rows={screen.schedule} />

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
    // leads with its sections.
    return (
        <Page title="League">
            <PageHeader
                tabs={(
                    <SegmentedControl
                        variant="tabs"
                        scrollable
                        value={screen.tab}
                        onChange={screen.handleTabChange}
                        options={LEAGUE_TABS.map((tab) => ({ label: tab.label, value: tab.key }))}
                        accessibilityLabel="League sections"
                        idBase="league-tab"
                        controlledPanelId={activePanelId}
                        style={styles.tabs}
                    />
                )}
            />
            <View
                nativeID={activePanelId}
                style={styles.panel}
                role="tabpanel"
                aria-label={`${activeTabLabel} league section`}
                aria-labelledby={activeTabId}
                accessibilityLabel={`${activeTabLabel} league section`}
            >
                <DeferredContent ready={screen.isTabLoaded && (screen.tab !== 'draft' || screen.activeDraftLoaded)} busy={screen.isTabRefreshing || screen.isTabLoading}>{renderTabContent()}</DeferredContent>
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
    freshness: { color: colors.textSecondary, fontSize: fontSize.sm, padding: spacing.md },
    panel: { flex: 1, minHeight: 0 },
    tabs: { flexWrap: 'nowrap' },
})

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

export default function LeagueScreenWithStatus() {
    return <ScreenStatusProvider><LeagueScreen /></ScreenStatusProvider>
}
