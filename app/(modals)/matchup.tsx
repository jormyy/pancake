import { useMemo, useState } from 'react'
import { ScrollView, View, useWindowDimensions } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { useMatchupData } from '@/hooks/use-matchup-data'
import { ScoreCard } from '@/components/ScoreCard'
import { MatchupForecastSummary } from '@/components/MatchupForecastSummary'
import { MatchupLineupView } from '@/components/MatchupLineupView'
import { DaySelector } from '@/components/DaySelector'
import { ScoreBreakdownSheet } from '@/components/ScoreBreakdownSheet'
import { statLineupWidth } from '@/components/MatchupRow'
import { Button, ErrorBanner, Page, usePageMetrics } from '@/components/ui'
import { DeferredContent } from '@/components/ui/DeferredContent'
import { useGoBack } from '@/components/ui/useGoBack'
import { breakpoints, layout, spacing } from '@/constants/tokens'
import { getGameDisplayState } from '@/lib/home-surface'
import { lineupStatColumns } from '@/lib/score-breakdown'
import type { LineupPlayer } from '@/lib/lineup'

type Details = { myPlayer: LineupPlayer | null; oppPlayer: LineupPlayer | null; slotType: string }

export default function OtherMatchupScreen() {
    const { matchupId } = useLocalSearchParams<{ matchupId: string }>()
    const { current, currentLeague: league, membershipValidated, membershipError, refresh: refreshMemberships } = useLeagueContext()
    const { user } = useAuth()
    const router = useRouter()
    const back = useGoBack('/')
    const { width, height } = useWindowDimensions()
    const { padX, usableWidth } = usePageMetrics()
    const narrow = width < breakpoints.phone
    const compact = narrow || height < 840
    const data = useMatchupData(matchupId ? current : null, user, league, membershipValidated, membershipError, refreshMemberships, matchupId)
    const { matchup, myLineup, oppLineup, selectedDate, weekDays, forecastState, liveSnapshot } = data
    const [details, setDetails] = useState<Details | null>(null)
    const settings = useMemo(() => league?.scoring_settings && typeof league.scoring_settings === 'object' && !Array.isArray(league.scoring_settings) ? league.scoring_settings as Record<string, number> : {}, [league?.scoring_settings])
    const columns = useMemo(() => lineupStatColumns(settings), [settings])
    const showColumns = !narrow && usableWidth >= statLineupWidth(columns)
    const projections = useMemo(() => new Map((forecastState.forecast?.games ?? []).filter(game => game.date === selectedDate).map(game => [`${game.memberId}:${game.playerId}`, game])), [forecastState.forecast, selectedDate])
    const playingTeams = useMemo(() => new Set(weekDays.find(day => day.date === selectedDate)?.playingTeams ?? []), [weekDays, selectedDate])
    const { liveTeams } = getGameDisplayState(liveSnapshot.todaysGames, liveSnapshot.freshness)
    return (
        <Page title="Matchup" width="full">
            <ScrollView testID="other-matchup-page" style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: padX, paddingBottom: spacing.xl }}>
                <View style={{ width: '100%', alignSelf: 'center', maxWidth: showColumns ? layout.statLineupMaxWidth : layout.lineupMaxWidth }}>
                    <Button title="Back to Home" variant="ghost" size="sm" onPress={back} />
                    {data.error ? <ErrorBanner message={data.error} onRetry={data.refresh} /> : null}
                    {!matchupId ? <ErrorBanner message="Choose a matchup from Home." onRetry={back} /> : null}
                    <DeferredContent ready={Boolean(data.error) || data.emptyConfirmed || Boolean(matchup && myLineup && oppLineup)}>
                        {matchup ? <>
                            <ScoreCard matchup={matchup} compact={compact}>
                                <MatchupForecastSummary {...forecastState} myMemberId={matchup.myMemberId} opponentMemberId={matchup.opponentMemberId} />
                            </ScoreCard>
                            {myLineup && oppLineup ? <MatchupLineupView
                                readOnly playerForecasts={projections} forecastStale={forecastState.stale}
                                myMemberId={matchup.myMemberId} opponentMemberId={matchup.opponentMemberId}
                                myLineup={myLineup} oppLineup={oppLineup} selected={null} getTargetState={() => null}
                                onTap={() => {}} saving={false} playingTeams={playingTeams}
                                liveStats={liveSnapshot.liveStats} liveTeams={liveTeams} scoringSettings={settings}
                                teamMatchups={liveSnapshot.teamMatchups} statColumns={showColumns ? columns : null}
                                onOpenDetails={setDetails} onOpenPlayer={player => router.push({ pathname: '/player/[id]', params: { id: player.playerId } })}
                                capacity={{ bench: myLineup.benchSlots, ir: league?.ir_slots ?? 2, taxi: league?.taxi_slots ?? 3 }}
                                compact={narrow} dense={height < 620}
                                daySelector={<DaySelector days={weekDays} selectedDate={selectedDate} onSelect={data.setSelectedDate} compact={compact} />}
                            /> : null}
                        </> : null}
                    </DeferredContent>
                </View>
            </ScrollView>
            <ScoreBreakdownSheet visible={details !== null} onClose={() => setDetails(null)} slotType={details?.slotType ?? ''}
                mine={{ player: details?.myPlayer ?? null, stats: details?.myPlayer ? liveSnapshot.liveStats.get(details.myPlayer.playerId) : undefined }}
                theirs={{ player: details?.oppPlayer ?? null, stats: details?.oppPlayer ? liveSnapshot.liveStats.get(details.oppPlayer.playerId) : undefined }} settings={settings} />
        </Page>
    )
}
