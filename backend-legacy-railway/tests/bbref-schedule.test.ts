import { describe, expect, it } from 'vitest'
import {
    isNonRegularMatchup,
    isPlayoffsDividerRow,
    parseBBRefScheduleHtml,
    type ScheduleParseState,
} from '../src/lib/bbref'

// Regular-season purity oracle for the BBRef historical backfill (2003-2019).
// BBRef monthly schedule pages list regular-season games, then a full-width
// "Playoffs" divider row, then postseason games. The All-Star game lists two
// non-franchise selections. Only regular-season games may reach a stat.

const gameRow = (bbrefId: string, awayCode: string): string => `
  <tr>
    <td data-stat="box_score_text"><a href="/boxscores/${bbrefId}.html">Box Score</a></td>
    <td data-stat="visitor_team_name"><a href="/teams/${awayCode}/2004.html">Visitor</a></td>
  </tr>`

const PLAYOFF_DIVIDER = '<tr class="thead"><th colspan="9">Playoffs</th></tr>'
const COLUMN_HEADER = '<tr class="thead"><th>Date</th><th>Visitor</th></tr>'

const page = (rows: string[]): string =>
    `<html><body><table id="schedule"><tbody>${rows.join('')}</tbody></table></body></html>`

const fresh = (): ScheduleParseState => ({ playoffsReached: false })

describe('BBRef schedule regular-season purity', () => {
    it('keeps regular-season games (both real franchises) and leaves state untouched', () => {
        const state = fresh()
        // home code = bbrefId.substring(9): NJN, DET, LAL — all real franchises
        const games = parseBBRefScheduleHtml(
            page([
                gameRow('200312010NJN', 'SAS'),
                gameRow('200312020DET', 'IND'),
                gameRow('200312030LAL', 'BOS'),
            ]),
            2004,
            'december',
            state,
        )
        expect(games.map((g) => g.bbrefId)).toEqual(['200312010NJN', '200312020DET', '200312030LAL'])
        expect(state.playoffsReached).toBe(false)
        // tricodes are mapped (NJN -> BKN, SAS stays SAS)
        expect(games[0]).toMatchObject({ homeTeam: 'BKN', awayTeam: 'SAS', gameDate: '2003-12-01' })
    })

    it('excludes postseason games at and after the Playoffs divider, and sets state', () => {
        const state = fresh()
        const games = parseBBRefScheduleHtml(
            page([
                gameRow('200404140DET', 'IND'), // last regular-season games
                gameRow('200404150LAL', 'SAC'),
                PLAYOFF_DIVIDER,
                gameRow('200404170DET', 'BOS'), // first-round playoffs — must be dropped
                gameRow('200404180LAL', 'HOU'),
            ]),
            2004,
            'april',
            state,
        )
        expect(games.map((g) => g.bbrefId)).toEqual(['200404140DET', '200404150LAL'])
        expect(state.playoffsReached).toBe(true)
    })

    it('drops every game in a later month once the postseason has started', () => {
        const state: ScheduleParseState = { playoffsReached: true }
        const games = parseBBRefScheduleHtml(
            page([gameRow('200405010DET', 'NJN'), gameRow('200405020LAL', 'SAS')]),
            2004,
            'may',
            state,
        )
        expect(games).toEqual([])
    })

    it('excludes All-Star / exhibition games (both sides non-franchise)', () => {
        const state = fresh()
        const games = parseBBRefScheduleHtml(
            page([
                gameRow('200402150DET', 'IND'), // regular
                gameRow('200402150LEB', 'GIA'), // All-Star: neither LEB nor GIA is a franchise
                gameRow('200402160LAL', 'BOS'), // regular
            ]),
            2004,
            'february',
            state,
        )
        expect(games.map((g) => g.bbrefId)).toEqual(['200402150DET', '200402160LAL'])
    })

    it('treats repeated column-header rows as headers, not the playoffs divider', () => {
        const state = fresh()
        const games = parseBBRefScheduleHtml(
            page([COLUMN_HEADER, gameRow('200401050DET', 'IND')]),
            2004,
            'january',
            state,
        )
        expect(games.map((g) => g.bbrefId)).toEqual(['200401050DET'])
        expect(state.playoffsReached).toBe(false)
    })

    it('throws when a loaded schedule page yields no boxscore rows (scraper breakage)', () => {
        const state = fresh()
        expect(() => parseBBRefScheduleHtml(page([COLUMN_HEADER]), 2004, 'november', state)).toThrow(
            /schedule rows missing/,
        )
    })

    it('throws on a played-game row missing its boxscore link', () => {
        const state = fresh()
        const brokenRow = '<tr><td data-stat="visitor_team_name"><a href="/teams/SAS/2004.html">x</a></td></tr>'
        expect(() => parseBBRefScheduleHtml(page([brokenRow]), 2004, 'november', state)).toThrow(
            /missing boxscore link/,
        )
    })
})

describe('BBRef purity predicates', () => {
    it('isPlayoffsDividerRow matches the postseason divider only', () => {
        expect(isPlayoffsDividerRow('Playoffs')).toBe(true)
        expect(isPlayoffsDividerRow('  PLAYOFFS  ')).toBe(true)
        expect(isPlayoffsDividerRow('Date Start (ET) Visitor')).toBe(false)
    })

    it('isNonRegularMatchup flags only all-non-franchise matchups', () => {
        expect(isNonRegularMatchup('LEB', 'GIA')).toBe(true) // All-Star
        expect(isNonRegularMatchup('DET', 'IND')).toBe(false) // regular
        expect(isNonRegularMatchup('DET', 'ZZZ')).toBe(false) // one unknown = map gap, keep
    })
})
