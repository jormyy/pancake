import {
    View,
    Text,
    StyleSheet,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors, fontSize, fontWeight, radii, spacing, layout } from '@/constants/tokens'
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

const LEAGUE_TAB_LABELS = Object.fromEntries(
    LEAGUE_TABS.map((tab) => [tab.key, tab.label]),
) as Record<(typeof LEAGUE_TABS)[number]['key'], string>
const PLACEHOLDER_ROWS = 7


function LeagueTabPlaceholder({ tab }: { tab: (typeof LEAGUE_TABS)[number]['key'] }) {
    const wideRows = tab === 'results' || tab === 'draftBoard'
    return (
        <View
            style={styles.tabPlaceholder}
            role="status"
            aria-busy
            aria-label={`${LEAGUE_TAB_LABELS[tab]} content loading`}
            accessibilityLabel={`${LEAGUE_TAB_LABELS[tab]} content loading`}
            accessibilityState={{ busy: true }}
        >
            <View style={styles.placeholderHeader}>
                <View style={styles.placeholderTitle} />
                <View style={styles.placeholderAction} />
            </View>
            {Array.from({ length: wideRows ? PLACEHOLDER_ROWS : 4 }, (_, index) => (
                <View key={index} style={[styles.placeholderRow, wideRows && styles.placeholderRowWide]}>
                    <View style={styles.placeholderAvatar} />
                    <View style={styles.placeholderRowBody}>
                        <View style={styles.placeholderLineStrong} />
                        <View style={styles.placeholderLine} />
                    </View>
                    {wideRows ? (
                        <View style={styles.placeholderValueGroup}>
                            <View style={styles.placeholderValue} />
                            <View style={styles.placeholderValue} />
                            <View style={styles.placeholderValue} />
                        </View>
                    ) : null}
                </View>
            ))}
        </View>
    )
}

function LeagueLoadingShell({ tab }: { tab: (typeof LEAGUE_TABS)[number]['key'] }) {
    const activePanelId = `league-panel-${tab}`
    const activeTabId = `league-tab-${tab}`
    const activeTabLabel = LEAGUE_TAB_LABELS[tab]

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.contentWrap}>
                <LeagueTabBar activeTab={tab} onTabChange={() => {}} />
                <View
                    nativeID={activePanelId}
                    style={styles.contentScroll}
                    role="tabpanel"
                    aria-label={`${activeTabLabel} league section`}
                    aria-labelledby={activeTabId}
                    accessibilityLabel={`${activeTabLabel} league section`}
                >
                    <LeagueTabPlaceholder tab={tab} />
                </View>
            </View>
        </SafeAreaView>
    )
}

export default function LeagueScreen() {
    const screen = useLeagueScreenState()
    const activePanelId = `league-panel-${screen.tab}`
    const activeTabId = `league-tab-${screen.tab}`
    const activeTabLabel = LEAGUE_TAB_LABELS[screen.tab]

    if (!screen.current) {
        if (screen.leagueLoading) {
            return <LeagueLoadingShell tab={screen.tab} />
        }
        return <NoLeagueState />
    }

    function renderTabContent() {
        if (screen.isTabLoading && !screen.isCurrentTabHydrated) {
            return <LeagueTabPlaceholder tab={screen.tab} />
        }

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
    contentWrap: { flex: 1, width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center', paddingHorizontal: spacing.md },
    contentScroll: { flex: 1 },
    tabPlaceholder: {
        flex: 1,
        padding: spacing.xl,
        gap: spacing.md,
        width: '100%',
        maxWidth: 760,
        alignSelf: 'center',
    },
    placeholderHeader: {
        minHeight: 52,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.lg,
        paddingHorizontal: spacing.lg,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        backgroundColor: colors.bgCard,
    },
    placeholderTitle: {
        width: 172,
        height: 16,
        borderRadius: radii.xs,
        backgroundColor: colors.bgMuted,
    },
    placeholderAction: {
        width: 112,
        height: 32,
        borderRadius: radii.md,
        backgroundColor: colors.bgSubtle,
        borderWidth: 1,
        borderColor: colors.borderLight,
    },
    placeholderRow: {
        minHeight: 76,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        paddingHorizontal: spacing.lg,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        backgroundColor: colors.bgCard,
    },
    placeholderRowWide: {
        minHeight: 58,
    },
    placeholderAvatar: {
        width: 34,
        height: 34,
        borderRadius: 17,
        backgroundColor: colors.bgMuted,
        borderWidth: 1,
        borderColor: colors.borderLight,
    },
    placeholderRowBody: {
        flex: 1,
        minWidth: 0,
        gap: spacing.sm,
    },
    placeholderLineStrong: {
        width: '52%',
        maxWidth: 220,
        height: 14,
        borderRadius: radii.xs,
        backgroundColor: colors.bgMuted,
    },
    placeholderLine: {
        width: '38%',
        maxWidth: 170,
        height: 11,
        borderRadius: radii.xs,
        backgroundColor: colors.bgSubtle,
    },
    placeholderValueGroup: {
        width: 172,
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: spacing.md,
    },
    placeholderValue: {
        width: 42,
        height: 12,
        borderRadius: radii.xs,
        backgroundColor: colors.bgMuted,
    },
})
