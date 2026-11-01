import { overlayLiveScores, readLiveSnapshot, type LiveSnapshot, type SavedLiveMatchup, type ScoringSettings } from '@pancake/core'
import type { HomeView } from '@/lib/cache/view-types'
import type { NBAGameRow, LiveStatLine } from '@/lib/games'

type LiveHome = HomeView & { todaysGames: NBAGameRow[]; liveStats: Record<string, LiveStatLine>; liveBasis?: SavedLiveMatchup[] }

export function liveScoreView(saved: LiveHome, snapshot: LiveSnapshot | null, settings: ScoringSettings, now: number) {
    const current = readLiveSnapshot(snapshot, saved.selectedDate, now)
    const overlay = overlayLiveScores(saved.liveBasis ?? [], current, settings, now)
    const points = new Map(overlay.matchups.map(matchup => [matchup.id, matchup]))
    const displayed = saved.matchup ? points.get(saved.matchup.id) : null
    const matchup = saved.matchup && displayed ? { ...saved.matchup,
        myPoints: saved.matchup.myMemberId === displayed.homeMemberId ? displayed.homePoints : displayed.awayPoints,
        opponentPoints: saved.matchup.opponentMemberId === displayed.homeMemberId ? displayed.homePoints : displayed.awayPoints,
    } : saved.matchup
    const liveStats = { ...saved.liveStats }
    for (const [id, value] of Object.entries(overlay.stats)) liveStats[id] = {
        points: value.points, rebounds: value.rebounds, assists: value.assists, steals: value.steals, blocks: value.blocks,
        turnovers: value.turnovers, threeMade: value.threePointersMade, fgMade: value.fieldGoalsMade, fgAttempted: value.fieldGoalsAttempted,
        ftMade: value.freeThrowsMade, ftAttempted: value.freeThrowsAttempted, fouls: value.fouls,
        doubleDouble: value.doubleDouble, tripleDouble: value.tripleDouble, minutesPlayed: value.minutesPlayed, didNotPlay: value.didNotPlay,
    }
    const todaysGames = saved.todaysGames.map(game => {
        const fresh = current?.mode === 'public' && !displayed?.stale ? current.games.find(row => row.nbaId === game.nba_game_id
            || row.nbaId == null && row.home.team === game.home_team && row.away.team === game.away_team) : null
        if (!fresh || game.status === 'Final') return game
        return { ...game, home_score: fresh.home.score, away_score: fresh.away.score, status: fresh.status,
            game_status_text: fresh.status === 'Final' ? 'Final' : fresh.clock ? `Q${fresh.period ?? 1} ${fresh.clock}` : game.game_status_text }
    })
    return { matchup, todaysGames, liveStats, delayed: Boolean(displayed?.stale),
        leagueMatchups: saved.leagueMatchups.map(matchup => {
            const score = points.get(matchup.id)
            return score ? { ...matchup, homePoints: score.homePoints, awayPoints: score.awayPoints } : matchup
        }),
    }
}
