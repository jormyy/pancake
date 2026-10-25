// Keyless player master-list source (ESPN public JSON), replacing the Sleeper
// API (commercial API use moving behind negotiated licensing, Aug 2026).
// Sleeper remains a dormant fallback behind PLAYER_SYNC_SOURCE=sleeper.
import { fetchWithRetry } from './retry.ts'
import { runBounded } from './runBounded.ts'
import { normalizeName } from './nameMatch.ts'
import { currentSeasonYear } from './season.ts'
import { errorMessage } from './responses.ts'

const ESPN_SITE_BASE_URL = Deno.env.get('ESPN_SITE_BASE_URL') ??
  'https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba'
const ESPN_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (compatible; PancakePlayerSync/1.0; +https://pancake.app)',
  Referer: 'https://www.espn.com/',
  Origin: 'https://www.espn.com',
}

// Minimum plausible payload sizes. A truncated or reshaped response is
// refused outright so a degraded scrape can never blank existing players;
// the next good sync self-heals.
const MIN_TEAMS = 28
const MIN_PLAYERS = 350

// The franchises a listing must cover before it can name anyone's absence,
// in players.nba_team codes. Covering them is necessary, not sufficient: a
// page can answer 200 and still omit a signed player.
const NBA_TEAM_CODES = [
  'ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GSW', 'HOU', 'IND', 'LAC', 'LAL', 'MEM',
  'MIA', 'MIL', 'MIN', 'NOP', 'NYK', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SAS', 'TOR', 'UTA', 'WAS',
]

// ESPN team abbreviations that differ from the NBA/Sleeper codes stored in
// players.nba_team.
const ESPN_TEAM_CODES: Record<string, string> = {
  GS: 'GSW',
  NO: 'NOP',
  NY: 'NYK',
  SA: 'SAS',
  UTAH: 'UTA',
  WSH: 'WAS',
}

// ESPN injury statuses mapped to the vocabulary the app already uses
// (isDTD/isIREligible + INJURY_COLORS).
const ESPN_INJURY_STATUSES: Record<string, string> = {
  'Out': 'Out',
  'Day-To-Day': 'DTD',
  'Questionable': 'Questionable',
  'Doubtful': 'Doubtful',
}

type SourcePlayerRecord = {
  espn_id: string
  first_name: string
  last_name: string
  nba_team: string | null
  position: string | null
  eligible_positions: string[]
  status: string | null
  injury_status?: string | null
  years_exp: number | null
}

export function mapEspnTeam(abbreviation: string | null | undefined): string | null {
  if (!abbreviation) return null
  return ESPN_TEAM_CODES[abbreviation] ?? abbreviation
}

function mapEspnInjuryStatus(status: string | null | undefined): string | null {
  if (!status) return null
  return ESPN_INJURY_STATUSES[status] ?? null
}

const ESPN_POSITIONS = new Set(['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'])

function mapEspnPosition(abbreviation: string | null | undefined): string | null {
  if (!abbreviation) return null
  return ESPN_POSITIONS.has(abbreviation) ? abbreviation : null
}

type EspnTeamsPayload = {
  sports?: { leagues?: { teams?: { team?: { id?: string; abbreviation?: string } }[] }[] }[]
}

type EspnAthlete = {
  id?: string | number
  firstName?: string
  lastName?: string
  fullName?: string
  position?: { abbreviation?: string }
  status?: { type?: string }
  experience?: { years?: number }
  draft?: { year?: number }
  debutYear?: number
}

type EspnRosterPayload = {
  athletes?: EspnAthlete[]
  season?: { year?: number }
}

type EspnInjuriesPayload = {
  injuries?: {
    injuries?: {
      status?: string
      athlete?: { id?: string | number; displayName?: string; firstName?: string; lastName?: string }
    }[]
  }[]
}

function extractEspnTeams(payload: EspnTeamsPayload): { id: string; abbreviation: string }[] {
  const teams = payload.sports?.[0]?.leagues?.[0]?.teams ?? []
  return teams.flatMap((entry) => {
    const id = entry.team?.id
    const abbreviation = entry.team?.abbreviation
    return id && abbreviation ? [{ id: String(id), abbreviation }] : []
  })
}

// The injuries feed identifies athletes by name only (no id), so statuses
// are keyed by normalized display name and joined to roster athletes the
// same way.
function extractEspnInjuryStatuses(payload: EspnInjuriesPayload): Map<string, string> {
  const byName = new Map<string, string>()
  for (const team of payload.injuries ?? []) {
    for (const injury of team.injuries ?? []) {
      const athlete = injury.athlete
      const name = athlete?.displayName ??
        [athlete?.firstName, athlete?.lastName].filter(Boolean).join(' ')
      const mapped = mapEspnInjuryStatus(injury.status)
      const key = name ? normalizeName(name) : ''
      if (key && mapped) byName.set(key, mapped)
    }
  }
  return byName
}

// Coarse ESPN positions map to eligibility sets the lineup engine can start:
// literal G/F are startable at their own slot plus UTIL, and the specific
// guard/forward slots accept the coarse label via LINEUP_SLOT_ALLOWED_POSITIONS.
function eligibleForPosition(position: string | null): string[] {
  if (position === 'G') return ['G']
  if (position === 'F') return ['F']
  return position ? [position] : []
}

type EspnRoster = { teamCode: string | null; athletes: EspnAthlete[]; seasonYear?: number }

const identified = (athlete: EspnAthlete) => athlete.id != null && Boolean(athlete.firstName || athlete.lastName)

/**
 * Reasons the fetched rosters cannot name every signed NBA player: a team
 * missing, repeated or unknown, an empty roster page, or an athlete the
 * import cannot key. No reasons means only that no gap is visible; a page
 * that silently omits a player looks the same.
 */
export function espnListingGaps(rosters: EspnRoster[]): string[] {
  const gaps: string[] = []
  const pages = new Map<string, number>()
  for (const roster of rosters) {
    const code = roster.teamCode ?? 'no team code'
    pages.set(code, (pages.get(code) ?? 0) + 1)
    if (!NBA_TEAM_CODES.includes(code)) gaps.push(`unexpected team ${code}`)
    if (roster.athletes.length === 0) gaps.push(`empty roster ${code}`)
    const unkeyed = roster.athletes.filter((athlete) => !identified(athlete)).length
    if (unkeyed > 0) gaps.push(`${unkeyed} unidentified athlete(s) on ${code}`)
  }
  for (const code of NBA_TEAM_CODES) {
    const count = pages.get(code) ?? 0
    if (count !== 1) gaps.push(count === 0 ? `missing roster ${code}` : `${count} rosters for ${code}`)
  }
  return gaps
}

function buildEspnRecords(
  rosters: EspnRoster[],
  injuriesByName: Map<string, string> | null,
): SourcePlayerRecord[] {
  const athleteName = (athlete: EspnAthlete) =>
    normalizeName(athlete.fullName ?? `${athlete.firstName ?? ''} ${athlete.lastName ?? ''}`)
  // The injuries feed has no athlete ids; a name shared by two rostered
  // players cannot be attributed, so those names get no injury status.
  const nameCounts = new Map<string, number>()
  for (const roster of rosters) {
    for (const athlete of roster.athletes) {
      const name = athleteName(athlete)
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
    }
  }

  const records: SourcePlayerRecord[] = []
  for (const roster of rosters) {
    for (const athlete of roster.athletes) {
      if (!identified(athlete)) continue
      const espnId = String(athlete.id)
      const position = mapEspnPosition(athlete.position?.abbreviation)
      const name = athleteName(athlete)
      records.push({
        espn_id: espnId,
        first_name: athlete.firstName ?? '',
        last_name: athlete.lastName ?? '',
        nba_team: roster.teamCode,
        position,
        eligible_positions: eligibleForPosition(position),
        status: athlete.status?.type === 'active' ? 'Active' : 'Inactive',
        ...(injuriesByName ? { injury_status: nameCounts.get(name) === 1 ? injuriesByName.get(name) ?? null : null } : {}),
        years_exp: yearsExperience(athlete, roster.seasonYear ?? currentSeasonYear()),
      })
    }
  }
  return records
}

function yearsExperience(athlete: EspnAthlete, seasonYear: number): number | null {
  const years = athlete.experience?.years
  if (typeof years === 'number' && Number.isInteger(years) && years >= 0) return years
  const firstYear = athlete.debutYear ?? athlete.draft?.year
  return typeof firstYear === 'number' && Number.isInteger(firstYear) && firstYear > 1946 && firstYear <= seasonYear
    ? Math.max(0, seasonYear - 1 - firstYear) : null
}

export async function fetchEspnInjuries(): Promise<{ statuses: Map<string, string> | null; failure: string | null }> {
  const response = await fetchWithRetry(`${ESPN_SITE_BASE_URL}/injuries`, { headers: ESPN_HEADERS })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`ESPN injuries ${response.status}`)
  }
  const injuries = await response.json() as EspnInjuriesPayload
  if (!Array.isArray(injuries?.injuries) || injuries.injuries.some(team => !team || !Array.isArray(team.injuries)
    || team.injuries.some(injury => !injury || typeof injury.status !== 'string' || !injury.athlete
      || !(injury.athlete.displayName || injury.athlete.firstName || injury.athlete.lastName)))) {
    throw new Error('ESPN injuries payload degraded; refusing to write')
  }
  const statuses = extractEspnInjuryStatuses(injuries)
  if (statuses.size === 0) {
    return { statuses: null, failure: 'ESPN injuries has no mapped statuses; injury_status unchanged' }
  }
  return { statuses, failure: null }
}

export async function fetchEspnPlayerListing(): Promise<{ records: SourcePlayerRecord[]; gaps: string[]; failure: string | null; injuryWarnings: number }> {
  const teamsRes = await fetchWithRetry(`${ESPN_SITE_BASE_URL}/teams`, { headers: ESPN_HEADERS })
  if (!teamsRes.ok) {
    await teamsRes.body?.cancel()
    throw new Error(`ESPN teams ${teamsRes.status}`)
  }
  const teams = extractEspnTeams(await teamsRes.json() as EspnTeamsPayload)
  if (teams.length < MIN_TEAMS) {
    throw new Error(`ESPN teams payload degraded: ${teams.length} teams (< ${MIN_TEAMS}); refusing to write`)
  }

  const rosters: EspnRoster[] = []
  await runBounded(teams.map((team) => async () => {
    const res = await fetchWithRetry(`${ESPN_SITE_BASE_URL}/teams/${team.id}/roster`, { headers: ESPN_HEADERS })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`ESPN roster ${team.abbreviation} ${res.status}`)
    }
    const payload = await res.json() as EspnRosterPayload
    rosters.push({ teamCode: mapEspnTeam(team.abbreviation), athletes: payload.athletes ?? [], seasonYear: payload.season?.year })
  }), 6)

  let statuses: Map<string, string> | null = null
  let injuryWarnings = 0
  try {
    const injuries = await fetchEspnInjuries()
    statuses = injuries.statuses
    if (injuries.failure) {
      injuryWarnings++
      console.warn(`[sync-players] ${injuries.failure}`)
    }
  } catch (error) {
    injuryWarnings++
    console.warn(`[sync-players] ${errorMessage(error)}; injury_status unchanged`)
  }

  const records = buildEspnRecords(rosters, statuses)
  if (records.length < MIN_PLAYERS) {
    throw new Error(`ESPN player payload degraded: ${records.length} players (< ${MIN_PLAYERS}); refusing to write`)
  }
  return { records, gaps: espnListingGaps(rosters), failure: null, injuryWarnings }
}

type SourceNewsItem = {
  title: string
  summary: string
  source: string
  url: string
  published_at: string
  espn_athlete_id: string | null
}

// ESPN's keyless NBA news feed. Articles tagged with an athlete map onto
// players.espn_id; untagged league-wide stories keep player_id null.
export async function fetchEspnNews(limit = 50): Promise<SourceNewsItem[]> {
  const res = await fetchWithRetry(`${ESPN_SITE_BASE_URL}/news?limit=${limit}`, { headers: ESPN_HEADERS })
  if (!res.ok) {
    await res.body?.cancel()
    throw new Error(`ESPN news ${res.status}`)
  }
  const payload = await res.json() as {
    articles?: {
      headline?: string
      description?: string
      published?: string
      links?: { web?: { href?: string } }
      categories?: { type?: string; athleteId?: number | string }[]
    }[]
  }
  const items: SourceNewsItem[] = []
  for (const article of payload.articles ?? []) {
    const url = article.links?.web?.href
    if (!article.headline || !article.published || !url) continue
    const athlete = (article.categories ?? []).find((category) =>
      category.type === 'athlete' && category.athleteId != null
    )
    items.push({
      title: article.headline,
      summary: article.description ?? article.headline,
      source: 'espn',
      url,
      published_at: article.published,
      espn_athlete_id: athlete?.athleteId != null ? String(athlete.athleteId) : null,
    })
  }
  return items
}
