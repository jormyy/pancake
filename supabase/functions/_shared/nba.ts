const NBA_CDN = 'https://cdn.nba.com/static/json'

const NBA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.nba.com',
  'Referer': 'https://www.nba.com/',
}

async function cdnGet(path: string): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(`${NBA_CDN}${path}`, { headers: NBA_HEADERS, signal: controller.signal })
    if (!res.ok) {
      const err = new Error(`CDN ${res.status} for ${path}`) as any
      err.status = res.status
      throw err
    }
    return await res.json()
  } finally {
    clearTimeout(timeout)
  }
}

export function parseNBAMinutes(iso: string | null | undefined): number | null {
  if (!iso) return null
  const m = iso.match(/PT(\d+)M/)
  return m ? parseInt(m[1]) : null
}

export async function fetchTodaysGames(): Promise<NBAGame[]> {
  const data = await cdnGet('/liveData/scoreboard/todaysScoreboard_00.json') as any
  return (data?.scoreboard?.games ?? []) as NBAGame[]
}

export async function fetchBoxScore(gameId: string): Promise<NBABoxScore> {
  const data = await cdnGet(`/liveData/boxscore/boxscore_${gameId}.json`) as any
  return data.game as NBABoxScore
}

export async function fetchSeasonSchedule(): Promise<NBAScheduledGame[]> {
  const data = await cdnGet('/staticData/scheduleLeagueV2_1.json') as any
  const gameDates: unknown[] = data?.leagueSchedule?.gameDates ?? []

  const games: NBAScheduledGame[] = []
  for (const day of gameDates as any[]) {
    for (const g of day.games ?? []) {
      const gameDate = g.gameDateEst
        ? g.gameDateEst.split('T')[0]
        : g.gameEt
          ? g.gameEt.split('T')[0]
          : null
      if (!gameDate) continue

      games.push({
        gameId: g.gameId,
        gameDate,
        homeTeam: g.homeTeam?.teamTricode ?? '',
        awayTeam: g.awayTeam?.teamTricode ?? '',
        status: mapGameStatus(g.gameStatus),
        startedAt: g.gameEt ?? null,
        weekNumber: g.weekNumber ?? null,
      })
    }
  }
  return games
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
  homeTeam: { teamTricode: string }
  awayTeam: { teamTricode: string }
}

export interface NBAScheduledGame {
  gameId: string
  gameDate: string
  homeTeam: string
  awayTeam: string
  status: string
  startedAt: string | null
  weekNumber: number | null
}

export interface NBABoxScore {
  gameId: string
  gameStatus: number
  gameEt: string | null
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
