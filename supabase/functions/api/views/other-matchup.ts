type Read = (name: 'matchup' | 'lineup' | 'standings' | 'forecast', params: Record<string, unknown>) => Promise<unknown>
type Entry = { id: string; homeMemberId: string; awayMemberId: string; homeTeamName: string; awayTeamName: string; homePoints: number | null; awayPoints: number | null; isFinalized: boolean }
type Standing = { memberId: string; wins: number; losses: number }

export async function otherMatchupView<Home extends Record<string, unknown>>(home: Home, matchupId: string, read: Read) {
  const entry = (home.leagueMatchups as Entry[]).find(row => row.id === matchupId)
  if (!entry) return null
  const context = home.context as { seasonId: string; seasonYear: number; weekNumber: number }
  const [metadata, mine, theirs, records, forecast] = await Promise.all([
    read('matchup', { id: matchupId }),
    read('lineup', { date: home.selectedDate, targetMemberId: entry.homeMemberId }),
    read('lineup', { date: home.selectedDate, targetMemberId: entry.awayMemberId }),
    read('standings', {}),
    read('forecast', { p_matchup_id: matchupId }),
  ])
  const row = metadata as { week_number: number; end_week_number: number | null; winner_member_id: string | null }
  const left = mine as Record<string, unknown>
  const right = theirs as Record<string, unknown>
  const standings = (records as { standings: Standing[] }).standings
  const homeRecord = standings.find(record => record.memberId === entry.homeMemberId)
  const awayRecord = standings.find(record => record.memberId === entry.awayMemberId)
  return {
    ...home,
    matchup: {
      id: entry.id, weekNumber: context.weekNumber, roundStartWeek: row.week_number,
      roundEndWeek: row.end_week_number ?? row.week_number, seasonId: context.seasonId, seasonYear: context.seasonYear,
      myMemberId: entry.homeMemberId, opponentMemberId: entry.awayMemberId,
      myTeamName: entry.homeTeamName, opponentTeamName: entry.awayTeamName, myUsername: '', opponentUsername: '',
      myPoints: entry.homePoints, opponentPoints: entry.awayPoints, isFinalized: entry.isFinalized,
      iWon: row.winner_member_id ? row.winner_member_id === entry.homeMemberId : null,
      myWins: homeRecord?.wins ?? 0, myLosses: homeRecord?.losses ?? 0,
      opponentWins: awayRecord?.wins ?? 0, opponentLosses: awayRecord?.losses ?? 0,
    },
    myLineup: left, oppLineup: right, weekDays: left.weekDays, forecast,
    todaysGames: left.games, startedTeams: left.startedTeams, teamMatchups: left.teamMatchups,
    liveStats: { ...left.liveStats as object, ...right.liveStats as object },
  }
}
