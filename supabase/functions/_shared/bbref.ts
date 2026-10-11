import * as cheerio from 'npm:cheerio@1.2.0'
import type { AnyNode } from 'npm:domhandler@5.0.3'
import { errorMessage } from './responses.ts'

const BBREF_BASE = 'https://www.basketball-reference.com'
const BBREF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

async function bbrefGet(path: string): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(`${BBREF_BASE}${path}`, { headers: BBREF_HEADERS, signal: controller.signal })
    if (!res.ok) {
      throw new BBRefHttpError(res.status, `BBRef ${res.status} for ${path}`)
    }
    return await res.text()
  } finally {
    clearTimeout(timeout)
  }
}

const BBREF_TO_TRICODE: Record<string, string> = {
  ATL: 'ATL', BOS: 'BOS',
  BRK: 'BKN', NJN: 'BKN',
  CHA: 'CHA', CHH: 'CHA', CHO: 'CHA',
  CHI: 'CHI', CLE: 'CLE', DAL: 'DAL',
  DEN: 'DEN', DET: 'DET', GSW: 'GSW',
  HOU: 'HOU', IND: 'IND', LAC: 'LAC',
  LAL: 'LAL', MEM: 'MEM', VAN: 'MEM',
  MIA: 'MIA', MIL: 'MIL', MIN: 'MIN',
  NOP: 'NOP', NOH: 'NOP', NOK: 'NOP',
  NYK: 'NYK', OKC: 'OKC', SEA: 'OKC',
  ORL: 'ORL', PHI: 'PHI', PHO: 'PHX',
  POR: 'POR', SAC: 'SAC', SAS: 'SAS',
  TOR: 'TOR', UTA: 'UTA',
  WAS: 'WAS', WSB: 'WAS',
}

const SCHEDULE_MONTHS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
])

// Real NBA franchise codes BBRef uses. Both "teams" of an All-Star / exhibition
// game (e.g. East/West, Team LeBron/Team Giannis) fall outside this set.
const NBA_FRANCHISE_CODES = new Set(Object.keys(BBREF_TO_TRICODE))

// Keep the schedule parser's regular-season filter aligned with the static guards.
function isPlayoffsDividerRow(text: string): boolean {
  return text.trim().toLowerCase().includes('playoff')
}

function isNonRegularMatchup(homeBBRef: string, awayBBRef: string): boolean {
  return !NBA_FRANCHISE_CODES.has(homeBBRef) && !NBA_FRANCHISE_CODES.has(awayBBRef)
}

interface ScheduleParseState {
  playoffsReached: boolean
}

function parseBBRefScheduleHtml(
  html: string,
  seasonEndYear: number,
  month: string,
  state: ScheduleParseState,
): BBRefGame[] {
  const $ = cheerio.load(html)
  if (!$('table#schedule').length) {
    throw new Error(`BBRef schedule table missing for ${seasonEndYear}/${month}`)
  }

  const games: BBRefGame[] = []
  let candidateRows = 0
  $('table#schedule tbody tr').each((_: number, row: AnyNode) => {
    const $row = $(row)
    if ($row.hasClass('thead')) {
      if (isPlayoffsDividerRow($row.text())) state.playoffsReached = true
      return
    }
    if (state.playoffsReached) return

    const boxScoreLink = $row.find('td[data-stat="box_score_text"] a').attr('href')
    if (!boxScoreLink) throw new Error(`BBRef schedule row missing boxscore link for ${seasonEndYear}/${month}`)
    candidateRows++

    const bbrefId = boxScoreLink.replace('/boxscores/', '').replace('.html', '')
    if (bbrefId.length < 12) throw new Error(`Malformed BBRef boxscore id for ${seasonEndYear}/${month}: ${bbrefId}`)

    const datePart = bbrefId.substring(0, 8)
    const gameDate = `${datePart.substring(0, 4)}-${datePart.substring(4, 6)}-${datePart.substring(6, 8)}`
    const homeTeamBBRef = bbrefId.substring(9)

    const visitorHref = $row.find('td[data-stat="visitor_team_name"] a').attr('href') ?? ''
    const awayTeamBBRef = visitorHref.split('/')[2]?.toUpperCase() ?? ''

    if (!homeTeamBBRef || !awayTeamBBRef) {
      throw new Error(`BBRef schedule row missing team code for ${seasonEndYear}/${month}/${bbrefId}`)
    }

    if (isNonRegularMatchup(homeTeamBBRef, awayTeamBBRef)) return

    const homeTeam = BBREF_TO_TRICODE[homeTeamBBRef] ?? homeTeamBBRef
    const awayTeam = BBREF_TO_TRICODE[awayTeamBBRef] ?? awayTeamBBRef

    games.push({ bbrefId, gameDate, homeTeamBBRef, awayTeamBBRef, homeTeam, awayTeam })
  })

  if (candidateRows === 0 && !state.playoffsReached) {
    throw new Error(`BBRef schedule rows missing for ${seasonEndYear}/${month}`)
  }

  return games
}

export interface BBRefGame {
  bbrefId: string
  gameDate: string
  homeTeamBBRef: string
  awayTeamBBRef: string
  homeTeam: string
  awayTeam: string
}

export interface BBRefPlayerStat {
  playerName: string
  dnp: boolean
  minutesDecimal: number | null
  pts: number
  reb: number
  orb: number
  drb: number
  ast: number
  stl: number
  blk: number
  tov: number
  pf: number
  fgm: number
  fga: number
  tpm: number
  tpa: number
  ftm: number
  fta: number
  plusMinus: number | null
}

export async function fetchBBRefSchedule(seasonEndYear: number): Promise<BBRefGame[]> {
  const indexPath = `/leagues/NBA_${seasonEndYear}_games.html`
  const $ = cheerio.load(await bbrefGet(indexPath))
  const paths = new Set<string>()
  $('a[href]').each((_, anchor) => {
    let url: URL
    try { url = new URL($(anchor).attr('href')!, `${BBREF_BASE}${indexPath}`) } catch { return }
    if (url.origin !== BBREF_BASE || url.search || url.hash) return
    const match = url.pathname.match(/^\/leagues\/NBA_(\d+)_games-([a-z]+)\.html$/)
    if (match && Number(match[1]) === seasonEndYear && SCHEDULE_MONTHS.has(match[2])) paths.add(url.pathname)
  })
  if (!paths.size) throw new Error(`BBRef schedule index ${seasonEndYear} advertises no supported month pages`)

  const games: BBRefGame[] = []
  const state: ScheduleParseState = { playoffsReached: false }
  for (const path of paths) {
    await sleep(3000)
    try {
      const html = await bbrefGet(path)
      games.push(...parseBBRefScheduleHtml(html, seasonEndYear, path, state))
    } catch (error) {
      throw new Error(`BBRef schedule ${seasonEndYear}/${path}: ${errorMessage(error)}`)
    }
  }
  return games
}

class BBRefHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function fetchBBRefBoxScore(
  bbrefId: string,
  homeTeamBBRef: string,
  awayTeamBBRef: string,
): Promise<{ home: BBRefPlayerStat[]; away: BBRefPlayerStat[] }> {
  const html = await bbrefGet(`/boxscores/${bbrefId}.html`)
  const $ = cheerio.load(html)

  const home = parseTeamTable($, homeTeamBBRef)
  const away = parseTeamTable($, awayTeamBBRef)

  if (!home.length) throw new Error(`BBRef home table missing for ${bbrefId}/${homeTeamBBRef}`)
  if (!away.length) throw new Error(`BBRef away table missing for ${bbrefId}/${awayTeamBBRef}`)

  return { home, away }
}

function parseTeamTable($: ReturnType<typeof cheerio.load>, teamCode: string): BBRefPlayerStat[] {
  const stats: BBRefPlayerStat[] = []
  const $table = $(`#box-${teamCode}-game-basic`)
  const $tbody = $table.find('tbody')
  if (!$tbody.length) return stats

  $tbody.find('tr').each((_: number, row: AnyNode) => {
    const $row = $(row)
    if ($row.hasClass('thead')) return

    const playerName = $row.find('th[data-stat="player"]').text().trim()
    if (playerName === 'Team Totals') return
    if (!playerName) throw new Error(`BBRef player name missing for ${teamCode}`)

    const mp = $row.find('td[data-stat="mp"]').text().trim()
    const reason = $row.find('td[data-stat="reason"]').text().trim()
    const dnp = reason.length > 0

    if (dnp) {
      stats.push({
        playerName, dnp: true, minutesDecimal: null,
        pts: 0, reb: 0, orb: 0, drb: 0, ast: 0, stl: 0, blk: 0,
        tov: 0, pf: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0,
        plusMinus: null,
      })
      return
    }

    const minutesDecimal = parseMpToDecimal(mp)
    if (minutesDecimal === null) {
      throw new Error(`Malformed BBRef minutes for ${teamCode}/${playerName}: ${mp}`)
    }

    const n = (stat: string) => {
      const v = $row.find(`td[data-stat="${stat}"]`).text().trim()
      if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) {
        throw new Error(`Malformed BBRef stat ${stat} for ${teamCode}/${playerName}: ${v}`)
      }
      return Number(v)
    }
    const nOrNull = (stat: string) => {
      const v = $row.find(`td[data-stat="${stat}"]`).text().trim()
      if (v === '' || v === '—') return null
      if (!/^[+-]?\d+$/.test(v)) {
        throw new Error(`Malformed BBRef stat ${stat} for ${teamCode}/${playerName}: ${v}`)
      }
      return parseInt(v, 10)
    }

    stats.push({
      playerName,
      dnp: false,
      minutesDecimal,
      pts: n('pts'), reb: n('trb'), orb: n('orb'), drb: n('drb'),
      ast: n('ast'), stl: n('stl'), blk: n('blk'), tov: n('tov'),
      pf: n('pf'), fgm: n('fg'), fga: n('fga'),
      tpm: n('fg3'), tpa: n('fg3a'), ftm: n('ft'), fta: n('fta'),
      plusMinus: nOrNull('plus_minus'),
    })
  })

  const isTotal = (_: number, row: AnyNode) => $(row).find('[data-stat="player"]').text().trim() === 'Team Totals'
  const footer = $table.find('tfoot tr').filter(isTotal)
  const totals = footer.length ? footer : $tbody.find('tr').filter(isTotal)
  if (totals.length !== 1) throw new Error(`BBRef team totals missing or ambiguous for ${teamCode}`)

  const additive: [keyof BBRefPlayerStat, string][] = [
    ['pts', 'pts'], ['fgm', 'fg'], ['fga', 'fga'], ['tpm', 'fg3'], ['tpa', 'fg3a'],
    ['ftm', 'ft'], ['fta', 'fta'], ['ast', 'ast'], ['stl', 'stl'], ['blk', 'blk'],
    ['reb', 'trb'], ['orb', 'orb'], ['drb', 'drb'],
  ]
  for (const [key, column] of additive) {
    const raw = totals.find(`[data-stat="${column}"]`).text().trim()
    const declared = Number(raw)
    const actual = stats.reduce((sum, player) => sum + Number(player[key]), 0)
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(declared) || actual !== declared) {
      throw new Error(`BBRef team total ${column} does not match player rows for ${teamCode}`)
    }
  }

  const teamTurnovers = totals.find('[data-stat="tov"]').text().trim()
  const playerTurnovers = stats.reduce((sum, player) => sum + player.tov, 0)
  // Team turnovers include events that are not assigned to a player.
  if (!/^\d+$/.test(teamTurnovers) || !Number.isSafeInteger(Number(teamTurnovers)) ||
      !Number.isSafeInteger(playerTurnovers) || playerTurnovers > Number(teamTurnovers)) {
    throw new Error(`BBRef team total tov is below player rows or malformed for ${teamCode}`)
  }

  const totalMp = totals.find('[data-stat="mp"]').text().trim()
  const wholeMinutes = /^\d+$/.test(totalMp)
  const declaredMinutes = wholeMinutes ? Number(totalMp) : parseMpToDecimal(totalMp)
  const active = stats.filter((player) => !player.dnp)
  const actualSeconds = active.reduce((sum, player) => sum + Math.round(player.minutesDecimal! * 60), 0)
  // Integer team minutes declare a duration; only player seconds introduce rounding.
  const roundingSeconds = active.length / 2 + 0.5
  if (declaredMinutes === null || !Number.isFinite(declaredMinutes) ||
      Math.abs(actualSeconds - declaredMinutes * 60) > roundingSeconds) {
    throw new Error(`BBRef team total minutes do not match player rows for ${teamCode}`)
  }
  return stats
}

function parseMpToDecimal(mp: string): number | null {
  const match = /^(\d+):([0-5]\d)$/.exec(mp)
  if (!match) return null
  const mins = Number(match[1])
  return Number.isSafeInteger(mins) ? mins + Number(match[2]) / 60 : null
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
