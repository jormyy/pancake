import { isRegularSeasonGameId } from './gameId.ts'
import { fetchWithRetry } from './retry.ts'
export { isRegularSeasonGameId } from './gameId.ts'

const NBA_CDN = Deno.env.get('NBA_CDN_BASE_URL') ?? 'https://cdn.nba.com/static/json'

const NBA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.nba.com',
  'Referer': 'https://www.nba.com/',
}

class CdnHttpError extends Error {
  status: number

  constructor(status: number, path: string) {
    super(`CDN ${status} for ${path}`)
    this.status = status
  }
}

type ScoreboardPayload = {
  scoreboard?: {
    games?: NBAGame[]
  }
}

type BoxScorePayload = {
  game?: NBABoxScore
}

type SchedulePayload = {
  leagueSchedule?: {
    seasonYear?: unknown
    gameDates?: NBAScheduleDayPayload[]
  }
}

type NBAScheduleDayPayload = {
  games?: NBAScheduleGamePayload[]
}

type NBAScheduleGamePayload = {
  gameId?: unknown
  gameDateEst?: unknown
  gameDateTimeEst?: unknown
  gameEt?: unknown
  gameDateTimeUTC?: unknown
  gameStatus?: unknown
  weekNumber?: unknown
  homeTeam?: { teamTricode?: unknown }
  awayTeam?: { teamTricode?: unknown }
}

async function cdnGet(path: string): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetchWithRetry(`${NBA_CDN}${path}`, { headers: NBA_HEADERS, signal: controller.signal })
    if (!res.ok) {
      throw new CdnHttpError(res.status, path)
    }
    return await res.json()
  } finally {
    clearTimeout(timeout)
  }
}

// Parse NBA ISO duration like "PT35M12.00S" → decimal minutes (e.g. 35.2)
export function parseNBAMinutes(iso: string | null | undefined): number | null {
  if (!iso) return null
  const m = iso.match(/PT(\d+)M([\d.]+)S/)
  if (!m) return null
  const mins = parseInt(m[1])
  const secs = parseFloat(m[2])
  return Math.round((mins + secs / 60) * 100) / 100
}

export async function fetchTodaysGames(): Promise<NBAGame[]> {
  const data = await cdnGet('/liveData/scoreboard/todaysScoreboard_00.json') as ScoreboardPayload
  return (data?.scoreboard?.games ?? []).filter((game) => isRegularSeasonGameId(game.gameId))
}

export async function fetchBoxScore(gameId: string): Promise<NBABoxScore> {
  const data = await cdnGet(`/liveData/boxscore/boxscore_${gameId}.json`) as BoxScorePayload
  if (!data.game) throw new Error(`NBA box score missing game payload for ${gameId}`)
  return data.game
}

export async function fetchSeasonSchedule(): Promise<NBAScheduledGame[]> {
  const data = await cdnGet('/staticData/scheduleLeagueV2_1.json') as SchedulePayload
  const scheduleSeasonYear = firstString(data?.leagueSchedule?.seasonYear)
  const gameDates = data?.leagueSchedule?.gameDates ?? []

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

function parseNBAScheduleGame(g: NBAScheduleGamePayload, scheduleSeasonYear: string | null = null): NBAScheduledGame | null {
  const gameId = firstString(g.gameId)
  const gameDateSource = firstString(g.gameDateEst, g.gameDateTimeEst, g.gameEt, g.gameDateTimeUTC)
  const gameDate = gameDateSource?.split('T')[0] ?? null
  if (!gameId || !gameDate) return null

  return {
    gameId,
    gameDate,
    homeTeam: firstString(g.homeTeam?.teamTricode) ?? '',
    awayTeam: firstString(g.awayTeam?.teamTricode) ?? '',
    status: typeof g.gameStatus === 'number' ? mapGameStatus(g.gameStatus) : 'Scheduled',
    startedAt: firstString(g.gameDateTimeUTC, g.gameDateTimeEst, g.gameEt),
    weekNumber: typeof g.weekNumber === 'number' ? g.weekNumber : null,
    scheduleSeasonYear,
  }
}

export function mapGameStatus(s: number): string {
  if (s === 1) return 'Scheduled'
  if (s === 2) return 'InProgress'
  if (s === 3) return 'Final'
  return 'Scheduled'
}

export interface NBAGame {
  gameId: string
  gameStatus: number
  gameStatusText: string
  homeTeam: { teamTricode: string; score: number }
  awayTeam: { teamTricode: string; score: number }
}

export interface NBAScheduledGame {
  gameId: string
  gameDate: string
  homeTeam: string
  awayTeam: string
  status: string
  startedAt: string | null
  weekNumber: number | null
  scheduleSeasonYear: string | null
}

export interface NBABoxScore {
  gameId: string
  gameStatus: number
  gameEt: string | null
  homeTeam: NBABoxScoreTeam
  awayTeam: NBABoxScoreTeam
}

interface NBABoxScoreTeam {
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
    minutes: string
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
