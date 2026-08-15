// Keyless player master-list source (ESPN public JSON), replacing the Sleeper
// API (commercial API use moving behind negotiated licensing, Aug 2026).
// Sleeper remains a dormant fallback behind PLAYER_SYNC_SOURCE=sleeper.
import { fetchWithRetry } from './retry.ts'
import { runBounded } from './runBounded.ts'
import { normalizeName } from './nameMatch.ts'

const ESPN_SITE_BASE_URL = Deno.env.get('ESPN_SITE_BASE_URL') ??
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'

// Minimum plausible payload sizes. A truncated or reshaped response is
// refused outright so a degraded scrape can never blank existing players;
// the next good sync self-heals.
const MIN_TEAMS = 28
const MIN_PLAYERS = 350

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

export type SourcePlayerRecord = {
  espn_id: string
  first_name: string
  last_name: string
  nba_team: string | null
  position: string | null
  eligible_positions: string[]
  status: string | null
  injury_status: string | null
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
}

type EspnRosterPayload = {
  athletes?: EspnAthlete[]
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
      if (name && mapped) byName.set(normalizeName(name), mapped)
    }
  }
  return byName
}

function buildEspnRecords(
  rosters: { teamCode: string | null; athletes: EspnAthlete[] }[],
  injuriesByName: Map<string, string>,
): SourcePlayerRecord[] {
  const records: SourcePlayerRecord[] = []
  for (const roster of rosters) {
    for (const athlete of roster.athletes) {
      if (athlete.id == null || (!athlete.firstName && !athlete.lastName)) continue
      const espnId = String(athlete.id)
      const position = mapEspnPosition(athlete.position?.abbreviation)
      records.push({
        espn_id: espnId,
        first_name: athlete.firstName ?? '',
        last_name: athlete.lastName ?? '',
        nba_team: roster.teamCode,
        position,
        eligible_positions: position ? [position] : [],
        status: athlete.status?.type === 'active' ? 'Active' : 'Inactive',
        injury_status: injuriesByName.get(
          normalizeName(athlete.fullName ?? `${athlete.firstName ?? ''} ${athlete.lastName ?? ''}`),
        ) ?? null,
        years_exp: typeof athlete.experience?.years === 'number' ? athlete.experience.years : null,
      })
    }
  }
  return records
}

export async function fetchEspnPlayerRecords(): Promise<SourcePlayerRecord[]> {
  const teamsRes = await fetchWithRetry(`${ESPN_SITE_BASE_URL}/teams`)
  if (!teamsRes.ok) {
    await teamsRes.body?.cancel()
    throw new Error(`ESPN teams ${teamsRes.status}`)
  }
  const teams = extractEspnTeams(await teamsRes.json() as EspnTeamsPayload)
  if (teams.length < MIN_TEAMS) {
    throw new Error(`ESPN teams payload degraded: ${teams.length} teams (< ${MIN_TEAMS}); refusing to write`)
  }

  const rosters: { teamCode: string | null; athletes: EspnAthlete[] }[] = []
  await runBounded(teams.map((team) => async () => {
    const res = await fetchWithRetry(`${ESPN_SITE_BASE_URL}/teams/${team.id}/roster`)
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`ESPN roster ${team.abbreviation} ${res.status}`)
    }
    const payload = await res.json() as EspnRosterPayload
    rosters.push({ teamCode: mapEspnTeam(team.abbreviation), athletes: payload.athletes ?? [] })
  }), 6)

  const injuriesRes = await fetchWithRetry(`${ESPN_SITE_BASE_URL}/injuries`)
  if (!injuriesRes.ok) {
    await injuriesRes.body?.cancel()
    throw new Error(`ESPN injuries ${injuriesRes.status}`)
  }
  const injuriesByName = extractEspnInjuryStatuses(await injuriesRes.json() as EspnInjuriesPayload)

  const records = buildEspnRecords(rosters, injuriesByName)
  if (records.length < MIN_PLAYERS) {
    throw new Error(`ESPN player payload degraded: ${records.length} players (< ${MIN_PLAYERS}); refusing to write`)
  }
  return records
}
