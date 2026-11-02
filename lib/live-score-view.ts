import { overlayLiveScores, readLiveSnapshot, type LiveSnapshot, type SavedLiveMatchup, type ScoringSettings } from '@pancake/core'
import type { HomeView } from '@/lib/cache/view-types'
import type { NBAGameRow, LiveStatLine } from '@/lib/games'

type LiveHome = HomeView & { todaysGames: NBAGameRow[]; liveStats: Record<string, LiveStatLine>; liveBasis?: SavedLiveMatchup[] }

export function liveScoreView(saved: LiveHome, snapshot: LiveSnapshot | readonly (LiveSnapshot | null)[] | null, settings: ScoringSettings, now: number) {
    const sources = Array.isArray(snapshot) ? snapshot.map(source => readLiveSnapshot(source, source?.date ?? saved.selectedDate, now)).filter((source): source is LiveSnapshot => source !== null)
        : [readLiveSnapshot(snapshot, saved.selectedDate, now)].filter((source): source is LiveSnapshot => source !== null)
    const current: LiveSnapshot | null = sources.length ? { version: 1, date: saved.selectedDate,
        mode: sources.some(source => source.mode === 'database') ? 'database' : 'public',
        capturedAt: Math.min(...sources.map(source => source.capturedAt)), games: sources.flatMap(source => source.games.map(game => ({ ...game, gameDate: source.date }))) } : null
    const basis = (saved.liveBasis ?? []).map(matchup => ({ ...matchup, players: matchup.players.map(player => {
        const game = (saved.liveGames ?? saved.todaysGames)?.find(game => game.nba_game_id === player.gameId)
        return { ...player, scheduledAt: game?.status === 'Scheduled' && game.game_time ? Date.parse(game.game_time) : undefined }
    }) }))
    const overlay = overlayLiveScores(basis, current, settings, now)
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
    const todaysGames = (saved.todaysGames ?? []).map(game => {
        const fresh = current?.mode === 'public' && !displayed?.stale ? current.games.find(row => row.nbaId === game.nba_game_id
            || row.nbaId == null && row.gameDate === (game.game_date ?? saved.selectedDate) && row.home.team === game.home_team && row.away.team === game.away_team) : null
        if (!fresh || game.status === 'Final') return game
        const clock = /^PT(?:(\d+)M)?(\d+(?:\.\d+)?)S$/.exec(fresh.clock ?? '')
        const period = fresh.period ?? 1
        const status = clock ? `${period > 4 ? `OT${period - 4}` : `Q${period}`} ${Number(clock[1] ?? 0)}:${String(Math.floor(Number(clock[2]))).padStart(2, '0')}` : game.game_status_text
        return { ...game, home_score: fresh.home.score, away_score: fresh.away.score, status: fresh.status,
            game_status_text: fresh.status === 'Final' ? 'Final' : status }
    })
    return { matchup, todaysGames, liveStats, delayed: Boolean(displayed?.stale),
        leagueMatchups: (saved.leagueMatchups ?? []).map(matchup => {
            const score = points.get(matchup.id)
            return score ? { ...matchup, homePoints: score.homePoints, awayPoints: score.awayPoints } : matchup
        }),
    }
}
