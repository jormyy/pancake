import { fetchWithRetry } from '../_shared/retry.ts'
import { currentSeasonYear } from '../_shared/season.ts'

const NBA_COM_BASE_URL = Deno.env.get('NBA_COM_BASE_URL') ?? 'https://www.nba.com'

export async function fetchNbaCareerProfile(nbaId: string, now: Date): Promise<{ years: number | null; noGames: boolean }> {
  const response = await fetchWithRetry(`${NBA_COM_BASE_URL}/player/${encodeURIComponent(nbaId)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.nba.com/' },
  }, { attemptTimeoutMs: 5000 })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`NBA career profile ${response.status}`)
  }
  const html = await response.text()
  const embedded = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)
  if (!embedded) throw new Error('NBA career profile has no player data')
  const info = JSON.parse(embedded[1])?.props?.pageProps?.player?.info as {
    PERSON_ID?: number; SEASON_EXP?: number; FROM_YEAR?: number; DRAFT_YEAR?: string; GAMES_PLAYED_FLAG?: string
  } | undefined
  if (!info || String(info.PERSON_ID) !== nbaId) throw new Error('NBA career profile identity mismatch')
  let years = typeof info.SEASON_EXP === 'number' && Number.isInteger(info.SEASON_EXP) && info.SEASON_EXP >= 0 ? info.SEASON_EXP : null
  if (years == null) {
    const firstYear = Number(info.FROM_YEAR || info.DRAFT_YEAR)
    if (Number.isInteger(firstYear) && firstYear > 1946 && firstYear <= currentSeasonYear(now)) years = Math.max(0, currentSeasonYear(now) - 1 - firstYear)
  }
  return { years, noGames: info.GAMES_PLAYED_FLAG === 'N' }
}
