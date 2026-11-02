import { workFetch } from '../_shared/workContext.ts'
import { sourceTimestamp } from '../_shared/sourceTimestamp.ts'
import { gameElapsedSeconds } from '../_shared/gameProgress.ts'
import type { NBAGame, NBABoxScorePlayer } from '../_shared/nba.ts'
import { sourceEnvironment } from '../_shared/sourceEnvironment.ts'

const ESPN = sourceEnvironment('ESPN_LIVE_BASE_URL') ?? 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
export const teamCode = (code: string) => ({ GS: 'GSW', NY: 'NYK', NO: 'NOP', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS' })[code] ?? code

type Status = { period: number; displayClock: string; type: { state: string; completed?: boolean; detail?: string } }
type Competition = { date: string; status: Status; competitors: { homeAway: string; score: string; team: { abbreviation: string } }[] }
export type EspnEvent = { id: string; date: string; season?: { type: number; year: number }; status: Status; competitions: Competition[] }
export type EspnSummary = {
  header: { id: string; season: { type: number; year: number }; competitions: Competition[] }
  meta?: { lastUpdatedAt?: string }
  boxscore?: { players: { team: { abbreviation: string }; statistics: { names: string[]; athletes: { athlete: { id: string; displayName: string }; didNotPlay: boolean; stats: string[] }[] }[] }[] }
}
export type EspnPlayer = { espnId: string; player: NBABoxScorePlayer; team: string }

async function get<T>(path: string, timeoutMs = 2500): Promise<T> {
  const response = await workFetch(`${ESPN}${path}`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
  if (!response.ok) throw new Error(`ESPN ${response.status} for ${path}`)
  return await response.json() as T
}

class EspnSnapshotError extends Error {}

type Backoff = { failures: number; retryAt: number }

export class EspnLiveSource {
  private backoffs = new Map<string, Backoff>()

  constructor(private readonly now: () => number = () => Date.now(), private readonly timeoutMs = 2500) {}

  private async request<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.backoffs.get(key)
    if (previous && this.now() < previous.retryAt) throw new Error(`ESPN ${key}: backoff until ${new Date(previous.retryAt).toISOString()}`)
    try {
      const value = await run()
      this.backoffs.delete(key)
      return value
    } catch (error) {
      const failures = error instanceof EspnSnapshotError ? 1 : Math.min((previous?.failures ?? 0) + 1, 4)
      const delay = error instanceof EspnSnapshotError ? 10_000 : Math.min(120_000, 20_000 * 2 ** (failures - 1))
      this.backoffs.set(key, { failures, retryAt: this.now() + delay })
      throw error
    }
  }

  scoreboard(dates: string[]): Promise<EspnEvent[]> {
    return this.request('scoreboard', async () => {
      const range = [...dates].sort().map(date => date.replaceAll('-', ''))
      const payload = await get<{ events: EspnEvent[] }>(`/scoreboard?dates=${range[0]}-${range.at(-1)}&limit=100`, this.timeoutMs)
      if (!Array.isArray(payload.events) || payload.events.some(event => !event || typeof event.id !== 'string' ||
        !Number.isFinite(Date.parse(event.date)) || !['pre', 'in', 'post'].includes(event.status?.type?.state) ||
        !Array.isArray(event.competitions) || event.competitions.length !== 1 || !Array.isArray(event.competitions[0]?.competitors))) {
        throw new Error('ESPN scoreboard has invalid events')
      }
      if (new Set(payload.events.map(event => event.id)).size !== payload.events.length) throw new Error('ESPN scoreboard has duplicate games')
      return payload.events
    })
  }

  summary(event: EspnEvent): Promise<ReturnType<typeof parseEspnSummary>> {
    return this.request(event.id, async () => {
      const payload = await get<EspnSummary>(`/summary?event=${encodeURIComponent(event.id)}`, this.timeoutMs)
      try {
        const parsed = parseEspnSummary(payload, event)
        if (Date.parse(parsed.sourceUpdatedAt) > this.now() + 5000) throw new Error(`ESPN ${event.id}: future source timestamp`)
        return parsed
      } catch (error) {
        throw new EspnSnapshotError(error instanceof Error ? error.message : String(error), { cause: error })
      }
    })
  }
}

export const liveEspnSource = new EspnLiveSource()

export function espnGame(id: string, competition: Competition): NBAGame {
  const home = competition.competitors.find(team => team.homeAway === 'home')
  const away = competition.competitors.find(team => team.homeAway === 'away')
  const status = competition.status
  if (!home || !away || !['in', 'post'].includes(status.type.state)) throw new Error(`ESPN ${id}: live sides/status missing`)
  const clock = /^(?:(\d+):)?(\d{1,2})(?:\.(\d+))?$/.exec(status.displayClock)
  if (!clock) throw new Error(`ESPN ${id}: invalid clock`)
  const game = {
    gameId: id, gameStatus: 2, period: status.period,
    gameClock: `PT${clock[1] ?? '0'}M${clock[2].padStart(2, '0')}${clock[3] ? '.' + clock[3] : ''}S`,
    gameStatusText: status.type.state === 'post' ? 'Awaiting final stats' : status.type.detail ?? `${status.displayClock} Q${status.period}`,
    homeTeam: { teamTricode: teamCode(home.team.abbreviation), score: Number(home.score) },
    awayTeam: { teamTricode: teamCode(away.team.abbreviation), score: Number(away.score) },
  }
  if ([home.score, away.score].some(score => !/^\d+$/.test(score) || !Number.isSafeInteger(Number(score)) || Number(score) > 2_147_483_647)) throw new Error(`ESPN ${id}: invalid score`)
  gameElapsedSeconds(game)
  return game
}

export function matchEspnGame(game: { game_date: string; home_team: string; away_team: string; season_year: number }, events: EspnEvent[]): EspnEvent | undefined {
  const matches = events.filter(event => {
    if (event.season?.type !== 2 || event.season.year !== game.season_year) return false
    const date = new Date(event.date).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const competitors = event.competitions[0]?.competitors ?? []
    return date === game.game_date && competitors.some(team => team.homeAway === 'home' && teamCode(team.team.abbreviation) === game.home_team)
      && competitors.some(team => team.homeAway === 'away' && teamCode(team.team.abbreviation) === game.away_team)
  })
  if (matches.length > 1) throw new Error(`Ambiguous ESPN game for ${game.away_team}@${game.home_team}/${game.game_date}`)
  return matches[0]
}

export function fallbackReason(nba: NBAGame | undefined, espn: NBAGame, now = Date.now()): string | null {
  if (!nba) return 'nba-unavailable'
  if (nba.gameStatus === 3) return null
  const elapsed = gameElapsedSeconds(nba)
  const ahead = gameElapsedSeconds(espn) > elapsed
  const scoreDiffers = nba.homeTeam.score !== espn.homeTeam.score || nba.awayTeam.score !== espn.awayTeam.score
  const age = nba.sourceUpdatedAt ? now - Date.parse(nba.sourceUpdatedAt) : 0
  if ((ahead || scoreDiffers) && age > 90_000 && gameElapsedSeconds(espn) >= elapsed) return 'nba-source-age'
  if (gameElapsedSeconds(espn) - elapsed > 90) return 'nba-clock-lag'
  return null
}

export function parseEspnSummary(summary: EspnSummary, event: EspnEvent): { game: NBAGame; players: EspnPlayer[]; sourceUpdatedAt: string } {
  if (summary.header.id !== event.id || summary.header.season.type !== 2 || summary.header.season.year !== event.season?.year) throw new Error(`ESPN ${event.id}: summary identity changed`)
  const game = espnGame(event.id, summary.header.competitions[0])
  const reference = espnGame(event.id, { ...event.competitions[0], status: event.status })
  if (game.homeTeam.teamTricode !== reference.homeTeam.teamTricode || game.awayTeam.teamTricode !== reference.awayTeam.teamTricode) throw new Error(`ESPN ${event.id}: summary sides changed`)
  const sourceUpdatedAt = sourceTimestamp(summary.meta?.lastUpdatedAt)
  if (!sourceUpdatedAt) throw new Error(`ESPN ${event.id}: summary source timestamp missing`)
  const sides = summary.boxscore?.players ?? []
  if (sides.length !== 2 || new Set(sides.map(side => teamCode(side.team.abbreviation))).size !== 2) throw new Error(`ESPN ${event.id}: incomplete box sides`)
  const seen = new Set<string>()
  const players = sides.flatMap(side => {
    const team = teamCode(side.team.abbreviation)
    if (![game.homeTeam.teamTricode, game.awayTeam.teamTricode].includes(team)) throw new Error(`ESPN ${event.id}: unexpected box side`)
    const groups = side.statistics.filter(group => group.names.includes('PTS'))
    if (groups.length !== 1) throw new Error(`ESPN ${event.id}: ambiguous statistics`)
    const group = groups[0]
    const result = group.athletes.filter(row => !row.didNotPlay).map(row => {
      const id = row.athlete.id
      if (!/^\d+$/.test(id) || seen.has(id)) throw new Error(`ESPN ${event.id}: duplicate/invalid athlete ${id}`)
      seen.add(id)
      const values = Object.fromEntries(group.names.map((name, index) => [name, row.stats[index]]))
      const count = (name: string, signed = false) => {
        if (!(signed ? /^[+-]?\d+$/ : /^\d+$/).test(values[name] ?? '')) throw new Error(`ESPN ${event.id}/${id}: invalid ${name}`)
        const value = Number(values[name])
        if (!Number.isSafeInteger(value) || value > 2_147_483_647 || value < (signed ? -2_147_483_648 : 0)) throw new Error(`ESPN ${event.id}/${id}: out-of-range ${name}`)
        return value
      }
      const pair = (name: string) => {
        const match = /^(\d+)-(\d+)$/.exec(values[name] ?? '')
        if (!match || Number(match[1]) > Number(match[2]) || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) > 2_147_483_647) throw new Error(`ESPN ${event.id}/${id}: invalid ${name}`)
        return [Number(match[1]), Number(match[2])]
      }
      const minutes = /^(\d+)(?::(\d{2}))?$/.exec(values.MIN ?? '')
      if (!minutes || Number(minutes[2] ?? 0) > 59) throw new Error(`ESPN ${event.id}/${id}: invalid MIN`)
      const [fgm, fga] = pair('FG'), [tpm, tpa] = pair('3PT'), [ftm, fta] = pair('FT')
      const statistics = {
        minutes: `PT${minutes[1]}M${minutes[2] ?? '00'}S`, points: count('PTS'), reboundsTotal: count('REB'), assists: count('AST'),
        reboundsOffensive: count('OREB'), reboundsDefensive: count('DREB'), steals: count('STL'), blocks: count('BLK'),
        turnovers: count('TO'), foulsPersonal: count('PF'), plusMinusPoints: count('+/-', true),
        fieldGoalsMade: fgm, fieldGoalsAttempted: fga, threePointersMade: tpm, threePointersAttempted: tpa, freeThrowsMade: ftm, freeThrowsAttempted: fta,
      }
      return { espnId: id, team, player: { personId: 0, name: row.athlete.displayName, played: 1, statistics } }
    })
    if (!result.length || result.reduce((sum, row) => sum + row.player.statistics.points, 0) !== (team === game.homeTeam.teamTricode ? game.homeTeam.score : game.awayTeam.score)) throw new Error(`ESPN ${event.id}: incomplete team points`)
    return result
  })
  return { game: { ...game, sourceUpdatedAt }, players, sourceUpdatedAt }
}
