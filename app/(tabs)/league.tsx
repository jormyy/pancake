import {
    View,
    Text,
    StyleSheet,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors, spacing, layout, fontSize, fontWeight } from '@/constants/tokens'
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

const LEAGUE_TAB_LABELS = Object.fromEntries(
    LEAGUE_TABS.map((tab) => [tab.key, tab.label]),
) as Record<(typeof LEAGUE_TABS)[number]['key'], string>


export default function LeagueScreen() {
    const screen = useLeagueScreenState()
    const activePanelId = `league-panel-${screen.tab}`
    const activeTabId = `league-tab-${screen.tab}`
    const activeTabLabel = LEAGUE_TAB_LABELS[screen.tab]

    if (!screen.current) {
        // No placeholder shell while the league context loads — the screen
        // stays blank and the real UI appears fully formed, with no reflow.
        if (screen.leagueLoading) {
            return <SafeAreaView style={styles.container} />
        }
        return <NoLeagueState />
    }

    function renderTabContent() {
        if (screen.tabErr && !screen.isTabLoading) {
            return (
                <ErrorBanner
                    message={`${activeTabLabel} could not load. Select to retry.`}
                    onRetry={screen.retryCurrentTab}
                />
            )
        }

        // Tab panels render only once their data is known, so content appears
        // fully formed instead of loading in pieces that shift the layout.
        if (!screen.isTabLoaded) return null
        if ((screen.tab === 'auctions' || screen.tab === 'draftBoard') && !screen.activeDraftLoaded) {
            return null
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
                    activeDraftLoading={screen.activeDraftLoading && !screen.activeDraftLoaded}
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
                <View style={styles.header}>
                    <Text style={styles.leagueName} role="heading" aria-level={1} accessibilityRole="header">
                        {screen.currentLeague?.name ?? 'League'}
                    </Text>
                    {screen.current?.team_name ? (
                        <Text style={styles.teamName}>{screen.current.team_name}</Text>
                    ) : null}
                </View>
                <LeagueTabBar activeTab={screen.tab} onTabChange={screen.handleTabChange} compact />
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
    contentWrap: { flex: 1, width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center', paddingHorizontal: spacing.md },
    contentScroll: { flex: 1 },
    header: {
        paddingTop: spacing.lg,
        paddingBottom: spacing.md,
        paddingHorizontal: spacing.md,
        gap: 2,
    },
    leagueName: { fontSize: fontSize['2lg'], fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    teamName: { fontSize: fontSize.md, color: colors.textSecondary },
})

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'
