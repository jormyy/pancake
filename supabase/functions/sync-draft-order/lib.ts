import { supabase } from '../_shared/supabase.ts'
import { errorMessage } from '../_shared/responses.ts'
import { fetchWithRetry } from '../_shared/retry.ts'
import { resolvePlayerImports } from '../_shared/playerImports.ts'
import { currentSeasonYear } from '../_shared/season.ts'

const NBA_STATS_URL = `${Deno.env.get('NBA_STATS_BASE_URL') ?? 'https://stats.nba.com'}/stats/drafthistory`
const NBA_COM_BASE_URL = Deno.env.get('NBA_COM_BASE_URL') ?? 'https://www.nba.com'
const MIN_COMPLETE_DRAFT_PICKS = 50

type DraftOrderSource = 'stats.nba.com' | 'nba.com'

type NBADraftPick = {
  overallPick: number
  playerName: string
  roundNumber: number
  roundPick: number
  teamName: string
}

const HTTP_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Referer: 'https://www.nba.com/',
  Origin: 'https://www.nba.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
}

function currentEtMonth(now = new Date()): number {
  const month = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'numeric',
  }).format(now))
  if (!Number.isInteger(month)) {
    throw new Error('Could not resolve current ET month')
  }
  return month
}

export function defaultDraftOrderSeasonYear(now = new Date()): number {
  const month = currentEtMonth(now)
  if (month !== 6 && month !== 7) {
    throw new Error('seasonYear is required outside the June/July draft-order sync window')
  }
  return currentSeasonYear(now)
}

/** The most recent June draft class in US Eastern time: this year's from June on, last year's before June. */
function latestDraftClassYear(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric' }).formatToParts(now)
  const year = Number(parts.find((part) => part.type === 'year')?.value)
  const month = Number(parts.find((part) => part.type === 'month')?.value)
  if (!Number.isInteger(year) || !Number.isInteger(month)) throw new Error('Could not resolve the current draft class')
  return month >= 6 ? year : year - 1
}

export async function syncDraftOrder(seasonYear: number, now = new Date()) {
  // A board replaces every current rookie draft number, so only the latest class may replace it. A past board
  // would turn veterans back into rookies and clear the current class; it is refused, not reinterpreted.
  const latestClass = latestDraftClassYear(now)
  if (seasonYear !== latestClass) {
    throw new Error(`Refusing the ${seasonYear} draft board: only the latest draft class (${latestClass}) can replace the rookie board`)
  }
  console.log(`[sync-draft-order] Fetching ${seasonYear} NBA draft order`)
  const { source, picks } = await fetchDraftOrder(seasonYear)
  if (picks.length < MIN_COMPLETE_DRAFT_PICKS) {
    throw new Error(`Refusing to sync incomplete draft board: ${picks.length} picks found`)
  }

  const imported = await resolvePlayerImports('nba_draft', picks.map((pick) => ({
    display_name: pick.playerName, nba_draft_number: pick.overallPick,
  })))

  await verifySyncedDraftBoard(picks)

  const result = {
    seasonYear,
    source,
    draftPickCount: picks.length,
    updated: imported.results.length,
    inserted: imported.results.filter((row) => row.action === 'inserted').length,
    staleDraftNumbersCleared: imported.staleDraftNumbersCleared,
    unmatched: [],
  }
  console.log('[sync-draft-order] Done', result)
  return result
}

async function fetchDraftOrder(seasonYear: number): Promise<{ source: DraftOrderSource; picks: NBADraftPick[] }> {
  const errors: string[] = []

  // This function runs from Supabase cloud IPs, where stats.nba.com commonly
  // stalls. Prefer NBA.com's public draft-order pages for the scheduled path.
  try {
    const picks = await fetchNbaComDraftOrder(seasonYear)
    if (picks.length >= MIN_COMPLETE_DRAFT_PICKS) return { source: 'nba.com', picks }
    errors.push(`nba.com returned ${picks.length} picks`)
  } catch (error) {
    errors.push(`nba.com: ${errorMessage(error)}`)
  }

  try {
    const picks = await fetchStatsDraftOrder(seasonYear)
    if (picks.length >= MIN_COMPLETE_DRAFT_PICKS) {
      console.warn(`[sync-draft-order] Falling back to stats.nba.com (${errors.join('; ')})`)
      return { source: 'stats.nba.com', picks }
    }
    errors.push(`stats.nba.com returned ${picks.length} picks`)
  } catch (error) {
    errors.push(`stats.nba.com: ${errorMessage(error)}`)
  }

  throw new Error(`Could not load a complete ${seasonYear} NBA draft board. ${errors.join('; ')}`)
}

async function fetchStatsDraftOrder(seasonYear: number): Promise<NBADraftPick[]> {
  const url = new URL(NBA_STATS_URL)
  url.searchParams.set('LeagueID', '00')
  url.searchParams.set('Season', String(seasonYear))
  url.searchParams.set('RoundNum', '')
  url.searchParams.set('RoundPick', '')
  url.searchParams.set('TeamID', '0')
  url.searchParams.set('Overall_Pick', '')
  url.searchParams.set('SeasonType', '')

  const res = await fetchWithTimeout(url.toString(), {
    headers: {
      ...HTTP_HEADERS,
      'x-nba-stats-origin': 'stats',
      'x-nba-stats-token': 'true',
    },
  })
  if (!res.ok) throw new Error(`NBA Stats API ${res.status}`)

  const data = await res.json()
  const resultSet = data?.resultSets?.[0]
  if (!resultSet) throw new Error('Unexpected response shape from NBA Stats API')

  const headers: string[] = resultSet.headers
  const idx = {
    playerName: headers.indexOf('PLAYER_NAME'),
    overall: headers.indexOf('OVERALL_PICK'),
    round: headers.indexOf('ROUND_NUMBER'),
    roundPick: headers.indexOf('ROUND_PICK'),
    teamName: headers.indexOf('TEAM_NAME'),
  }
  if (Object.values(idx).some((i) => i < 0)) {
    throw new Error('NBA Stats draft history response is missing required columns')
  }

  if (!Array.isArray(resultSet.rowSet)) throw new Error('NBA Stats draft history has no record array')
  return validateDraftPicks(resultSet.rowSet.map((row: unknown) => {
    if (!Array.isArray(row) || typeof row[idx.playerName] !== 'string') {
      throw new Error('NBA Stats draft history has a malformed player record')
    }
    return {
      overallPick: Number(row[idx.overall]),
      playerName: row[idx.playerName].trim(),
      roundNumber: Number(row[idx.round]),
      roundPick: Number(row[idx.roundPick]),
      teamName: String(row[idx.teamName] ?? ''),
    }
  }))
}

async function fetchNbaComDraftOrder(seasonYear: number): Promise<NBADraftPick[]> {
  const visited = new Set<string>()
  const queue = [
    `${NBA_COM_BASE_URL}/news/${seasonYear}-nba-draft-order`,
    `${NBA_COM_BASE_URL}/draft/${seasonYear}`,
  ]
  const errors: string[] = []

  for (let i = 0; i < queue.length; i++) {
    const url = queue[i]
    if (visited.has(url)) continue
    visited.add(url)
    try {
      const res = await fetchWithTimeout(url, { headers: HTTP_HEADERS })
      if (!res.ok) throw new Error(`NBA.com ${res.status}`)
      const html = await res.text()
      const picks = parseDraftPicksFromNbaComHtml(html)
      if (picks.length >= MIN_COMPLETE_DRAFT_PICKS) return picks
      for (const linkedUrl of findDraftOrderLinks(html, seasonYear)) {
        if (!visited.has(linkedUrl)) queue.push(linkedUrl)
      }
      errors.push(`${url}: found ${picks.length} draft picks`)
    } catch (error) {
      errors.push(`${url}: ${errorMessage(error)}`)
    }
  }

  throw new Error(`Could not load a complete ${seasonYear} NBA draft board from NBA.com. ${errors.join('; ')}`)
}

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  // Per-attempt timeout for headers, plus an overall deadline that also covers
  // the body read (same shape as cdnGet).
  return fetchWithRetry(url, { ...init, signal: AbortSignal.timeout(45_000) }, { attemptTimeoutMs: 20_000 })
}

function parseDraftPicksFromNbaComHtml(html: string): NBADraftPick[] {
  const articleText = extractArticleText(html)
  return articleText ? parseDraftPicksFromArticleText(articleText) : []
}

function parseDraftPicksFromArticleText(articleText: string): NBADraftPick[] {
  const picks: NBADraftPick[] = []
  const lines = articleText
    .replace(/&gt;/g, '>')
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  for (const line of lines) {
    const match = line.match(/^([+-]?\d+)\.\s+(.+)$/)
    if (!match) {
      if (/^(?:[-*•#(]\s*)?[+-]?\s*\d+(?:$|[.)\s:–—-])/.test(line)) throw new Error('Unrecognized numbered NBA draft entry')
      continue
    }

    const overallPick = Number(match[1])
    const beforeParenthetical = match[2].replace(/\s+\(.+$/, '').trim()
    const pickMatch = beforeParenthetical.match(/^(.+?)\s+(?:drafts?|selects?|takes?|picks?|from)\s+(.+)$/i)
    if (!pickMatch) throw new Error(`Unrecognized NBA draft pick #${overallPick}`)

    const playerName = cleanPlayerName(pickMatch[2])
    if (!playerName) throw new Error(`Missing player for NBA draft pick #${overallPick}`)
    picks.push({
      overallPick,
      playerName,
      teamName: pickMatch[1].trim(),
      roundNumber: overallPick <= 30 ? 1 : 2,
      roundPick: overallPick <= 30 ? overallPick : overallPick - 30,
    })
  }

  return validateDraftPicks(picks)
}

function extractArticleText(html: string): string | null {
  const nextData = extractNextData(html)
  const articleText = nextData?.props?.pageProps?.article?.contentText
  return typeof articleText === 'string' ? articleText : null
}

function findDraftOrderLinks(html: string, seasonYear: number): string[] {
  const nextData = extractNextData(html)
  const links = new Set<string>()
  const wanted = `${seasonYear}-nba-draft-order`

  function visit(value: unknown): void {
    if (!value) return
    if (typeof value === 'string') {
      if (value.includes(wanted)) links.add(toAbsoluteNbaUrl(value))
      return
    }
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value === 'object') {
      for (const nested of Object.values(value)) visit(nested)
    }
  }

  visit(nextData)
  return [...links]
}

function extractNextData(html: string): any | null {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

function toAbsoluteNbaUrl(url: string): string {
  if (url.startsWith('http')) return url
  if (url.startsWith('/')) return `${NBA_COM_BASE_URL}${url}`
  return `${NBA_COM_BASE_URL}/${url}`
}

function cleanPlayerName(name: string): string {
  return name
    .replace(/\s+via\s+.+$/i, '')
    .replace(/\s+to\s+.+$/i, '')
    .replace(/[;:,]+$/g, '')
    .trim()
}

function validateDraftPicks(picks: NBADraftPick[]): NBADraftPick[] {
  const byOverall = new Map<number, NBADraftPick>()
  for (const pick of picks) {
    if (
      !Number.isInteger(pick.overallPick) ||
      pick.overallPick < 1 ||
      pick.overallPick > 60 ||
      !pick.playerName.trim()
    ) throw new Error('Malformed NBA draft pick; refusing a partial board')
    if (byOverall.has(pick.overallPick)) throw new Error(`Duplicate NBA draft pick #${pick.overallPick}`)
    byOverall.set(pick.overallPick, pick)
  }
  return [...byOverall.values()].sort((a, b) => a.overallPick - b.overallPick)
}

async function verifySyncedDraftBoard(picks: NBADraftPick[]): Promise<void> {
  const { data, error } = await supabase
    .from('players')
    .select('nba_draft_number')
    .eq('years_exp', 0)
    .not('nba_draft_number', 'is', null)
    .order('nba_draft_number', { ascending: true })
  if (error) throw error

  const expected = new Set(picks.map((pick) => pick.overallPick))
  const actual = new Set((data ?? []).map((player) => Number(player.nba_draft_number)))
  const missing = [...expected].filter((pick) => !actual.has(pick))
  const extras = [...actual].filter((pick) => !expected.has(pick))
  if (missing.length > 0 || extras.length > 0 || (data ?? []).length !== picks.length) {
    throw new Error(
      `Verification failed after sync. missing=[${missing.join(',')}], extras=[${extras.join(',')}], ` +
      `rows=${(data ?? []).length}, expected=${picks.length}`,
    )
  }
}
