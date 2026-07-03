import {
    View,
    Text,
    Pressable,
    StyleSheet,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors, fontSize, fontWeight, radii, spacing, layout } from '@/constants/tokens'
import { EmptyState } from '@/components/EmptyState'
import { StandingsTable, ActivityFeed } from '@/components/league/LeagueSections'
import {
    AuctionPanel,
    DraftBoardPanel,
    MockRoomsPanel,
    SettingsPanel,
} from '@/components/league/LeagueDraftPanels'
import { LeagueTabBar } from '@/components/league/LeagueTabBar'
import { useLeagueScreenState } from '@/hooks/use-league-screen-state'

export default function LeagueScreen() {
    const screen = useLeagueScreenState()

    if (!screen.current) {
        return <EmptyState message="Join or create a league first." />
    }

    function renderTabContent() {
        if (screen.tabErr && !screen.isTabLoading) {
            return (
                <Pressable
                    style={styles.errorBanner}
                    onPress={screen.retryCurrentTab}
                >
                    <Text style={styles.errorBannerText}>Failed to load. Tap to retry.</Text>
                </Pressable>
            )
        }

        if (screen.tab === 'results') {
            return (
                <StandingsTable
                    standings={screen.standings}
                    myMemberId={screen.current?.id}
                    onSelectTeam={screen.openTeamRoster}
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
                loadingMore={screen.activityLoadingMore}
                loadMoreError={screen.activityLoadMoreError}
            />
        )
    }

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.contentWrap}>
                <View style={styles.header}>
                    <View style={styles.headerTop}>
                        <View style={styles.headerInfo}>
                            <Text style={styles.currentLeagueName} numberOfLines={2}>
                                {screen.currentLeague?.name}
                            </Text>
                            <Text style={styles.teamName} numberOfLines={1}>
                                {screen.current.team_name}
                            </Text>
                        </View>
                    </View>
                </View>

                <LeagueTabBar activeTab={screen.tab} onTabChange={screen.handleTabChange} />
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
