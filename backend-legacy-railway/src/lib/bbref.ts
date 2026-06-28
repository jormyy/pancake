import axios from 'axios'
import * as cheerio from 'cheerio'
import { sleep } from './utils/sleep'

const client = axios.create({
    baseURL: 'https://www.basketball-reference.com',
    timeout: 30000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    },
})

// BBRef team abbreviations → NBA tricodes (handles all historical franchises back to 2003)
export const BBREF_TO_TRICODE: Record<string, string> = {
    ATL: 'ATL', BOS: 'BOS',
    BRK: 'BKN', NJN: 'BKN',                    // Nets
    CHA: 'CHA', CHH: 'CHA', CHO: 'CHA',         // Charlotte
    CHI: 'CHI', CLE: 'CLE', DAL: 'DAL',
    DEN: 'DEN', DET: 'DET', GSW: 'GSW',
    HOU: 'HOU', IND: 'IND', LAC: 'LAC',
    LAL: 'LAL', MEM: 'MEM', VAN: 'MEM',         // Vancouver/Memphis
    MIA: 'MIA', MIL: 'MIL', MIN: 'MIN',
    NOP: 'NOP', NOH: 'NOP', NOK: 'NOP',         // New Orleans
    NYK: 'NYK', OKC: 'OKC', SEA: 'OKC',         // Seattle/OKC
    ORL: 'ORL', PHI: 'PHI', PHO: 'PHX',
    POR: 'POR', SAC: 'SAC', SAS: 'SAS',
    TOR: 'TOR', UTA: 'UTA',
    WAS: 'WAS', WSB: 'WAS',                      // Washington Bullets
}

const SCHEDULE_MONTHS = [
    'october', 'november', 'december', 'january',
    'february', 'march', 'april', 'may', 'june',
]

// Real NBA franchise codes BBRef uses. Both "teams" of an All-Star / exhibition
// game (e.g. East/West, Team LeBron/Team Giannis) fall outside this set.
const NBA_FRANCHISE_CODES = new Set(Object.keys(BBREF_TO_TRICODE))

// BBRef monthly schedule pages mark the postseason with a full-width "Playoffs"
// header row (class="thead"). Every game listed at or after it is postseason.
export function isPlayoffsDividerRow(text: string): boolean {
    return text.trim().toLowerCase().includes('playoff')
}

// All-Star / exhibition games list both sides as non-franchise selections, so a
// matchup where NEITHER side is a real franchise is not a regular-season game.
// (A single unknown code is treated as a franchise-map gap, not an exhibition.)
export function isNonRegularMatchup(homeBBRef: string, awayBBRef: string): boolean {
    return !NBA_FRANCHISE_CODES.has(homeBBRef) && !NBA_FRANCHISE_CODES.has(awayBBRef)
}

export interface ScheduleParseState {
    // Set once the postseason divider is crossed. The BBRef schedule is
    // chronological, so once true no later month contains regular-season games.
    playoffsReached: boolean
}

// Parse one monthly schedule page into regular-season games only. Pure (cheerio
// over a string) so it is unit-testable against HTML fixtures. Mutates
// `state.playoffsReached` when the postseason divider is crossed.
export function parseBBRefScheduleHtml(
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
    $('table#schedule tbody tr').each((_, row) => {
        const $row = $(row)
        if ($row.hasClass('thead')) {
            if (isPlayoffsDividerRow($row.text())) state.playoffsReached = true
            return
        }
        // Drop every postseason row once the divider has been crossed.
        if (state.playoffsReached) return

        const boxScoreLink = $row.find('td[data-stat="box_score_text"] a').attr('href')
        if (!boxScoreLink) throw new Error(`BBRef schedule row missing boxscore link for ${seasonEndYear}/${month}`)
        candidateRows++

        // "/boxscores/200312010NJN.html" → "200312010NJN"
        const bbrefId = boxScoreLink.replace('/boxscores/', '').replace('.html', '')
        if (bbrefId.length < 12) throw new Error(`Malformed BBRef boxscore id for ${seasonEndYear}/${month}: ${bbrefId}`)

        // BBRef game ID: YYYYMMDD + 0 + TEAM
        const datePart = bbrefId.substring(0, 8)
        const gameDate = `${datePart.substring(0, 4)}-${datePart.substring(4, 6)}-${datePart.substring(6, 8)}`
        const homeTeamBBRef = bbrefId.substring(9) // everything after the "0" separator

        // Away team from the visitor column href: "/teams/SAS/2004.html"
        // BBRef schedule pages use data-stat="visitor_team_name" (verified against live HTML);
        // there is no visitor_team_id column. Must match _shared/bbref.ts.
        const visitorHref = $row.find('td[data-stat="visitor_team_name"] a').attr('href') ?? ''
        const awayTeamBBRef = visitorHref.split('/')[2]?.toUpperCase() ?? ''

        if (!homeTeamBBRef || !awayTeamBBRef) {
            throw new Error(`BBRef schedule row missing team code for ${seasonEndYear}/${month}/${bbrefId}`)
        }

        // Exclude All-Star / exhibition games — only regular-season data reaches a stat.
        if (isNonRegularMatchup(homeTeamBBRef, awayTeamBBRef)) return

        const homeTeam = BBREF_TO_TRICODE[homeTeamBBRef] ?? homeTeamBBRef
        const awayTeam = BBREF_TO_TRICODE[awayTeamBBRef] ?? awayTeamBBRef

        games.push({ bbrefId, gameDate, homeTeamBBRef, awayTeamBBRef, homeTeam, awayTeam })
    })

    // A loaded schedule page must yield at least one boxscore-bearing row, unless
    // the postseason divider explains why no regular-season games remain.
    if (candidateRows === 0 && !state.playoffsReached) {
        throw new Error(`BBRef schedule rows missing for ${seasonEndYear}/${month}`)
    }

    return games
}

export interface BBRefGame {
    bbrefId: string      // e.g. "200312010SAS"
    gameDate: string     // YYYY-MM-DD
    homeTeamBBRef: string
    awayTeamBBRef: string
    homeTeam: string     // NBA tricode
    awayTeam: string     // NBA tricode
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

// Scrape all games for a season from BBRef monthly schedule pages
// seasonEndYear: ending year (2004 = 2003-04 season)
export async function fetchBBRefSchedule(seasonEndYear: number): Promise<BBRefGame[]> {
    const games: BBRefGame[] = []
    const state: ScheduleParseState = { playoffsReached: false }

    for (const month of SCHEDULE_MONTHS) {
        // The schedule is chronological; once the postseason starts every later
        // month is entirely playoffs, so stop fetching (and counting) them.
        if (state.playoffsReached) break

        const url = `/leagues/NBA_${seasonEndYear}_games-${month}.html`
        try {
            const { data } = await client.get(url)
            games.push(...parseBBRefScheduleHtml(data, seasonEndYear, month, state))
        } catch (e: any) {
            // 404 = no games that month (normal for june in early rounds, etc.)
            if (e.response?.status !== 404) {
                throw new Error(`BBRef schedule ${seasonEndYear}/${month}: ${e.message}`)
            }
        }
        await sleep(3000)
    }

    return games
}

// Fetch player stats from a BBRef box score page
export async function fetchBBRefBoxScore(
    bbrefId: string,
    homeTeamBBRef: string,
    awayTeamBBRef: string,
): Promise<{ home: BBRefPlayerStat[]; away: BBRefPlayerStat[] }> {
    const { data } = await client.get(`/boxscores/${bbrefId}.html`)
    const $ = cheerio.load(data)

    const home = parseTeamTable($, homeTeamBBRef)
    const away = parseTeamTable($, awayTeamBBRef)

    if (!home.length) throw new Error(`BBRef home table missing for ${bbrefId}/${homeTeamBBRef}`)
    if (!away.length) throw new Error(`BBRef away table missing for ${bbrefId}/${awayTeamBBRef}`)

    return { home, away }
}

function parseTeamTable($: cheerio.CheerioAPI, teamCode: string): BBRefPlayerStat[] {
    const stats: BBRefPlayerStat[] = []
    const $tbody = $(`#box-${teamCode}-game-basic tbody`)
    if (!$tbody.length) return stats

    $tbody.find('tr').each((_, row) => {
        const $row = $(row)
        if ($row.hasClass('thead')) return

        const playerName = $row.find('th[data-stat="player"] a').text().trim()
        if (!playerName || playerName === 'Team Totals') return

        const mp = $row.find('td[data-stat="mp"]').text().trim()
        const reason = $row.find('td[data-stat="reason"]').text().trim()
        const dnp = !mp || reason.length > 0

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
            if (!/^[+-]?\d+$/.test(v)) {
                throw new Error(`Malformed BBRef stat ${stat} for ${teamCode}/${playerName}: ${v}`)
            }
            return parseInt(v, 10)
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

    return stats
}

// "32:47" → 32.78 minutes
export function parseMpToDecimal(mp: string): number | null {
    if (!mp) return null
    const parts = mp.split(':')
    if (parts.length !== 2) return null
    const mins = parseInt(parts[0])
    const secs = parseInt(parts[1])
    if (isNaN(mins) || isNaN(secs)) return null
    return mins + secs / 60
}
