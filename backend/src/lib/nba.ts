import axios from 'axios'
import { isRegularSeasonGameId } from '@pancake/core'
export { isRegularSeasonGameId } from '@pancake/core'

const NBA_CDN = process.env.NBA_CDN_BASE_URL ?? 'https://cdn.nba.com/static/json'

// Headers required to avoid NBA CDN blocks
const client = axios.create({
    timeout: 20000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.nba.com',
        'Referer': 'https://www.nba.com/',
    },
})

// Parse NBA ISO duration like "PT35M12.00S" → decimal minutes (e.g. 35.2)
export function parseNBAMinutes(iso: string | null | undefined): number | null {
    if (!iso) return null
    const m = iso.match(/PT(\d+)M([\d.]+)S/)
    if (!m) return null
    const mins = parseInt(m[1])
    const secs = parseFloat(m[2])
    return Math.round((mins + secs / 60) * 100) / 100
}

// GET today's scoreboard — returns list of games with status + scores
export async function fetchTodaysGames(): Promise<NBAGame[]> {
    const { data } = await client.get(`${NBA_CDN}/liveData/scoreboard/todaysScoreboard_00.json`)
    return ((data?.scoreboard?.games ?? []) as NBAGame[]).filter((game) => isRegularSeasonGameId(game.gameId))
}

// GET live/final box score for a specific game
export async function fetchBoxScore(gameId: string): Promise<NBABoxScore> {
    const { data } = await client.get(`${NBA_CDN}/liveData/boxscore/boxscore_${gameId}.json`)
    return data.game as NBABoxScore
}

// GET full season schedule from NBA CDN static file
// NOTE: The _1 suffix is season-specific; update for 2025-26 → scheduleLeagueV2_2.json (or similar)
export async function fetchSeasonSchedule(): Promise<NBAScheduledGame[]> {
    const { data } = await client.get(`${NBA_CDN}/staticData/scheduleLeagueV2_1.json`)
    const scheduleSeasonYear = firstString(data?.leagueSchedule?.seasonYear)
    const gameDates: any[] = data?.leagueSchedule?.gameDates ?? []

    const games: NBAScheduledGame[] = []
    for (const day of gameDates) {
        for (const g of day.games ?? []) {
            const game = parseNBAScheduleGame(g, scheduleSeasonYear)
            if (game) games.push(game)
        }
    }
    return games
}

function firstString(...values: unknown[]): string | null {
    for (const value of values) {
        if (typeof value === 'string' && value.length > 0) return value
    }
    return null
}

export function parseNBAScheduleGame(g: any, scheduleSeasonYear: string | null = null): NBAScheduledGame | null {
    const gameDateSource = firstString(g.gameDateEst, g.gameDateTimeEst, g.gameEt, g.gameDateTimeUTC)
    const gameDate = gameDateSource?.split('T')[0] ?? null
    if (!gameDate) return null

    return {
        gameId: g.gameId,
        gameDate,
        homeTeam: g.homeTeam?.teamTricode ?? '',
        awayTeam: g.awayTeam?.teamTricode ?? '',
        status: mapGameStatus(g.gameStatus),
        startedAt: firstString(g.gameDateTimeUTC, g.gameDateTimeEst, g.gameEt),
        weekNumber: g.weekNumber ?? null,
        scheduleSeasonYear,
    }
}

function mapGameStatus(s: number): string {
    if (s === 1) return 'Scheduled'
    if (s === 2) return 'InProgress'
    if (s === 3) return 'Final'
    return 'Scheduled'
}


export interface NBAGame {
    gameId: string
    gameStatus: number // 1=Scheduled, 2=Live, 3=Final
    gameStatusText: string
    homeTeam: { teamTricode: string; score: number }
    awayTeam: { teamTricode: string; score: number }
}

export interface NBAScheduledGame {
    gameId: string
    gameDate: string // YYYY-MM-DD
    homeTeam: string // tricode
    awayTeam: string // tricode
    status: string
    startedAt: string | null
    weekNumber: number | null
    scheduleSeasonYear: string | null
}

export interface NBABoxScore {
    gameId: string
    gameStatus: number
    gameEt: string | null   // ISO timestamp e.g. "2023-11-03T19:00:00-04:00"
    homeTeam: NBABoxScoreTeam
    awayTeam: NBABoxScoreTeam
}

export interface NBABoxScoreTeam {
    teamTricode: string
    players: NBABoxScorePlayer[]
}

export interface NBABoxScorePlayer {
    personId: number
    name: string
    statistics: {
        assists: number
        blocks: number
        fieldGoalsAttempted: number
        fieldGoalsMade: number
        foulsPersonal: number
        freeThrowsAttempted: number
        freeThrowsMade: number
        minutes: string // ISO duration: "PT35M12.00S"
        plusMinusPoints: number
        points: number
        reboundsDefensive: number
        reboundsOffensive: number
        reboundsTotal: number
        steals: number
        threePointersAttempted: number
        threePointersMade: number
        turnovers: number
    }
}
