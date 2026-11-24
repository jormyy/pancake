import { OtherMatchups } from '@/components/OtherMatchups'
import { MatchupLineupView } from '@/components/MatchupLineupView'
import { useScrollRestoration } from '@/lib/scroll-restoration'
import { MatchupForecastSummary } from '@/components/MatchupForecastSummary'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { usePullToRefresh } from '@/hooks/use-pull-to-refresh'

import { DeferredContent } from '@/components/ui/DeferredContent'
import {
    View,
    StyleSheet,
    ScrollView,
    RefreshControl,
    useWindowDimensions,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WeekOffNotice } from '@/components/WeekOffNotice'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner, Page, usePageMetrics } from '@/components/ui'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import type { LineupPlayer } from '@/lib/lineup'
import { breakpoints, colors, layout, spacing } from '@/constants/tokens'
import { DaySelector } from '@/components/DaySelector'
import { ScoreCard } from '@/components/ScoreCard'
import { NoLeagueState } from '@/components/NoLeagueState'
import { statLineupWidth } from '@/components/MatchupRow'
import { ScoreBreakdownSheet } from '@/components/ScoreBreakdownSheet'
import { MatchupPlayerSheet } from '@/components/player/MatchupPlayerSheet'
import { useDayProjections } from '@/hooks/use-day-projections'
import { lineupStatColumns } from '@/lib/score-breakdown'
import { useMatchupData } from '@/hooks/use-matchup-data'
import { getGameDisplayState, readHomeGameDisplay, resolveHomeSurface, saveHomeGameDisplay } from '@/lib/home-surface'

import { useDraftRoomLauncher } from '@/hooks/use-draft-room-launcher'
import { adjacentMatchupId } from '@/lib/matchup-navigation'
import { rosterLimits } from '@/lib/roster-capacity'

type DetailsRow = { myPlayer: LineupPlayer | null; oppPlayer: LineupPlayer | null; slotType: string }

export default function HomeScreen() {
    const { memberships, current, currentLeague: league, membershipValidated, membershipError, refresh: refreshMemberships, loading: leagueLoading } = useLeagueContext()
    const limits = useMemo(() => rosterLimits(league), [league])
    const { user, loading: authLoading } = useAuth()
    const router = useRouter()
    const { width, height } = useWindowDimensions()
    const { padX, usableWidth } = usePageMetrics()
    // Short screens tighten vertical spacing; only narrow screens shorten names.
    const narrow = width < breakpoints.phone
    const compact = narrow || height < 840
    const dense = height < 620
    const { openDraftRoom } = useDraftRoomLauncher(league?.id, { notifyOnError: true })

    const { matchup, leagueMatchups, weekDays, selectedDate, setSelectedDate, myLineup, oppLineup, matchupLoading, matchupRefreshing, lineupLoading, lineupError, loadLineups, matchupRef, error, refresh, emptyConfirmed, forecastState, liveSnapshot, timezone } = useMatchupData(current, user, league, membershipValidated, membershipError, refreshMemberships)
    const homeActivity = useBrowserReadActivity()
    const lastHomeActivityRevision = useRef(0)
    const refreshHome = refresh
    useEffect(() => {
        if (!homeActivity.active || homeActivity.revision <= lastHomeActivityRevision.current) return
        lastHomeActivityRevision.current = homeActivity.revision
        void refreshHome()
    }, [homeActivity.active, homeActivity.revision, refreshHome])
    const refreshingHome = Boolean(matchupRefreshing)
    const railPullRefresh = usePullToRefresh(refreshHome, refreshingHome)
    const homeSurface = resolveHomeSurface({ leagueStatus: league?.status, hasMatchup: Boolean(matchup), loading: matchupLoading, error, emptyConfirmed })

    const livePlayerIds = useMemo(() => [myLineup, oppLineup].flatMap(lineup => lineup ? [
        ...lineup.starters.flatMap(slot => slot.player ? [slot.player.playerId] : []),
        ...lineup.bench.map(player => player.playerId),
        ...lineup.ir.map(player => player.playerId),
        ...lineup.taxi.map(player => player.playerId),
    ] : []), [myLineup, oppLineup])
    const gameScope = JSON.stringify([user?.id, league?.id, current?.id, matchup?.seasonId, matchup?.id])
    const gamePlayers = useMemo(() => JSON.stringify([...new Set(livePlayerIds)].sort()), [livePlayerIds])
    const { todaysGames: gameRows = [], liveStats: gameStats, startedTeams: gameStartedTeams, teamMatchups: gameMatchups, freshness = 'fresh' } = liveSnapshot
    const gameSnapshot = useMemo(() => ({ todaysGames: gameRows, liveStats: gameStats, startedTeams: gameStartedTeams, teamMatchups: gameMatchups }), [gameRows, gameStats, gameStartedTeams, gameMatchups])
    const savedGames = useMemo(() => matchup ? readHomeGameDisplay(gameScope, selectedDate, gamePlayers) : null, [matchup, gameScope, selectedDate, gamePlayers])
    const { todaysGames = [], liveStats, teamMatchups } = !gameRows.length && freshness !== 'fresh' && savedGames ? savedGames : gameSnapshot
    useEffect(() => {
        if (matchup?.id && freshness === 'fresh') saveHomeGameDisplay(gameScope, selectedDate, gamePlayers, gameSnapshot)
    }, [matchup?.id, freshness, gameScope, selectedDate, gamePlayers, gameSnapshot])
    const { ready: gamesReady, liveTeams } = useMemo(() => getGameDisplayState(todaysGames, freshness), [todaysGames, freshness])

    const pageRef = useRef<ScrollView>(null)
    const pageScroll = useScrollRestoration(JSON.stringify([user?.id, league?.id, current?.id, selectedDate]), pageRef)

    const handleDaySelect = useCallback(
        async (date: string) => {
            if (!matchupRef.current) return
            setSelectedDate(date)
            await loadLineups(matchupRef.current, date)
        },
        [matchupRef, setSelectedDate, loadLineups],
    )

    const todayPlayingTeams = useMemo(
        () => new Set(weekDays.find((d) => d.date === selectedDate)?.playingTeams ?? []),
        [weekDays, selectedDate],
    )

    const scoringSettings = useMemo(
        () =>
            league?.scoring_settings &&
            typeof league.scoring_settings === 'object' &&
            !Array.isArray(league.scoring_settings)
                ? (league.scoring_settings as Record<string, number>)
                : {},
        [league?.scoring_settings],
    )

    // Wide screens show a box score per row; the side column only joins when
    // the lineup still fits next to it.
    const statColumns = useMemo(() => lineupStatColumns(scoringSettings), [scoringSettings])
    const statLineupMin = statLineupWidth(statColumns)
    const showStatColumns = !narrow && usableWidth >= statLineupMin
    const lineupWidth = showStatColumns ? layout.statLineupMaxWidth : layout.lineupMaxWidth

    const [detailsRow, setDetailsRow] = useState<DetailsRow | null>(null)
    const [previewPlayer, setPreviewPlayer] = useState<LineupPlayer | null>(null)
    const projectionLineups = useMemo(() => [myLineup, oppLineup], [myLineup, oppLineup])
    const dayProjections = useDayProjections(league?.id, selectedDate, projectionLineups, scoringSettings)
    const openMatchup = (id: string | null) => {
        if (id && id !== matchup?.id) router.push({ pathname: '/(modals)/matchup', params: { matchupId: id, date: selectedDate } })
    }


    // Stay blank while auth/league context loads — flashing the NoLeagueState
    // welcome (or any placeholder) and then swapping it for the real screen is
    // exactly the layout jump this screen must avoid.
    if (authLoading || (leagueLoading && memberships.length === 0)) {
        return <View style={styles.blank} />
    }
    if (!user) return <NoLeagueState />
    if (memberships.length === 0) return <NoLeagueState />

    return (
        <Page title="Matchup" width="full">
            <ScrollView {...railPullRefresh} {...pageScroll} ref={pageRef} testID="matchup-page-scroll" style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: spacing.xl }}
                refreshControl={<RefreshControl refreshing={refreshingHome} onRefresh={refreshHome} tintColor={colors.primaryDark} />}>
            {/* The error card owns the retry when there is no matchup to show; the banner covers a failed refresh over live data. */}
            {error && homeSurface !== 'error' && <ErrorBanner onRetry={refreshHome} />}

            {lineupError && matchup ? <ErrorBanner message="Couldn't load this day. Tap to retry." onRetry={() => { void handleDaySelect(selectedDate) }} /> : null}
            <DeferredContent ready={homeSurface !== 'loading' && (homeSurface !== 'matchup' || lineupError || Boolean(myLineup && oppLineup && gamesReady))} busy={refreshingHome || lineupLoading}>
            {matchup ? (
                <View style={[styles.playSurface, { paddingHorizontal: padX }]}>
                    <View style={[styles.mainColumn, { maxWidth: lineupWidth }]}>

                    <ScoreCard matchup={matchup} compact={compact}
                        onPreviousMatchup={() => openMatchup(adjacentMatchupId(leagueMatchups, matchup.id, -1))}
                        onNextMatchup={() => openMatchup(adjacentMatchupId(leagueMatchups, matchup.id, 1))}>
                        <MatchupForecastSummary {...forecastState} myMemberId={matchup.myMemberId} opponentMemberId={matchup.opponentMemberId} />
                    </ScoreCard>

                    {myLineup && oppLineup ? (
                        <MatchupLineupView
                            myLineup={myLineup}
                            oppLineup={oppLineup}
                            playingTeams={todayPlayingTeams}
                            liveStats={liveStats}
                            liveTeams={liveTeams}
                            onCourt={liveSnapshot.onCourt}
                            scoringSettings={scoringSettings}
                            teamMatchups={teamMatchups}
                            timezone={timezone}
                            statColumns={showStatColumns ? statColumns : null}
                            onOpenDetails={setDetailsRow}
                            onOpenPlayer={setPreviewPlayer}
                            projections={dayProjections}
                            capacity={{
                                bench: myLineup.benchSlots ?? 0,
                                ir: limits?.irSlots ?? 0,
                                taxi: limits?.taxiSlots ?? 0,
                            }}
                            compact={narrow}
                            dense={dense}
                            daySelector={weekDays.length > 0 ? (
                                <DaySelector timezone={league?.timezone} days={weekDays} selectedDate={selectedDate} onSelect={handleDaySelect} compact={compact} />
                            ) : null}
                        />
                    ) : weekDays.length > 0 ? (
                        <DaySelector timezone={league?.timezone} days={weekDays} selectedDate={selectedDate} onSelect={handleDaySelect} compact={compact} />
                    ) : null}
                    <OtherMatchups matchups={leagueMatchups} currentMatchupId={matchup.id} onOpen={openMatchup} />
                    </View>
                </View>
            ) : homeSurface === 'draft' ? (
                <View style={styles.playSurface}>
                    <EmptyState
                        fullScreen={false}
                        framed
                        icon="flash-on"
                        message="Your draft is live"
                        description="The auction draft is underway — nominate players and build your roster before the season tips off."
                        actionLabel="Go to Draft Room"
                        onAction={() => { void openDraftRoom() }}
                    />
                </View>
            ) : homeSurface === 'error' ? (
                // A failed load is not an empty week: never tell the manager no
                // matchup exists when the request simply failed (offline, cold cache).
                <View style={styles.playSurface}>
                    <EmptyState
                        fullScreen={false}
                        framed
                        icon="cloud-off"
                        message="Couldn't load your matchup"
                        description="Check your connection and try again. Nothing here is stale data."
                        actionLabel="Retry"
                        onAction={refreshHome}
                    />
                </View>
            ) : (
                <View style={styles.playSurface}>
                    <View>
                        <WeekOffNotice leagueId={league?.id} onBrowse={() => router.push('/players')} />
                    </View>
                </View>
            )}

            </DeferredContent>
            </ScrollView>

            <ScoreBreakdownSheet
                visible={detailsRow != null}
                onClose={() => setDetailsRow(null)}
                slotType={detailsRow?.slotType ?? ''}
                mine={{ player: detailsRow?.myPlayer ?? null, stats: detailsRow?.myPlayer ? liveStats.get(detailsRow.myPlayer.playerId) : undefined }}
                theirs={{ player: detailsRow?.oppPlayer ?? null, stats: detailsRow?.oppPlayer ? liveStats.get(detailsRow.oppPlayer.playerId) : undefined }}
                settings={scoringSettings}
            />

            <MatchupPlayerSheet player={previewPlayer} leagueId={league?.id} onClose={() => setPreviewPlayer(null)}
                onOpenPage={player => router.push({ pathname: '/player/[id]', params: { id: player.playerId } })} />

        </Page>
    )
}

const styles = StyleSheet.create({
    blank: { flex: 1, backgroundColor: colors.bgScreen },
    playSurface: { flex: 1, minHeight: 0 },
    mainColumn: { flex: 1, minHeight: 0, width: '100%', alignSelf: 'center' },
})
