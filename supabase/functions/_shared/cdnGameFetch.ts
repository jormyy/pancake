import type { NBABoxScorePlayer } from './nba.ts'

export type CdnGamePlayer = NBABoxScorePlayer & { isHome?: boolean }

const CDN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://www.nba.com',
  'Referer': 'https://www.nba.com/',
}

export type CdnGame = {
  gameStatus?: number
  gameEt?: string
  homeTeam?: { teamTricode?: string; players?: NBABoxScorePlayer[] }
  awayTeam?: { teamTricode?: string; players?: NBABoxScorePlayer[] }
}

type CdnBoxScore = {
  game?: CdnGame
}

export async function fetchCdnGameOrMiss(gameId: string, baseUrl: string): Promise<CdnGame | 'missing' | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  try {
    const res = await fetch(
      `${baseUrl}/liveData/boxscore/boxscore_${gameId}.json`,
      { headers: CDN_HEADERS, signal: controller.signal },
    )
    if (!res.ok) {
      // An already failed body must not change the known HTTP status.
      await res.body?.cancel().catch(() => {})
      if (res.status === 404) return 'missing'
      throw new Error(`CDN ${res.status}`)
    }
    const data = await res.json() as CdnBoxScore
    return data.game ?? null
  } finally {
    clearTimeout(timeout)
  }
}
