import { describe, expect, it } from 'vitest'
import { fantasyCalendar, completeSeasonSchedule } from '../src/season/schedule'
import { resolveSeasonWeekNumber } from '../src/season/weekPolicy'

describe('published fantasy week ranges', () => {
    const weeks = fantasyCalendar(['2025-10-21', '2025-10-26', '2026-02-09', '2026-02-12', '2026-02-19', '2026-02-22', '2026-03-09'])
    it('resolves both halves and the break to the same saved week', () => {
        for (const date of ['2026-02-09', '2026-02-16', '2026-02-22']) {
            expect(resolveSeasonWeekNumber(weeks, date, 'exact')).toBe(17)
        }
    })
    it('shifts later numbers without shifting the opening week', () => {
        expect(weeks[0]).toEqual({ week_number: 1, week_start: '2025-10-21', week_end: '2025-10-26' })
        expect(weeks.at(-1)?.week_number).toBe(20)
    })
    it('does not infer a merge from one empty day', () => {
        expect(fantasyCalendar(['2025-12-22', '2025-12-23', '2025-12-25', '2025-12-28', '2025-12-29']).map(week => week.week_number)).toEqual([1, 2])
    })
    it('requires a full thirty-team season before marking unseen games unavailable', () => {
        const games = Array.from({ length: 1230 }, (_, index) => ({ gameDate: index < 600 ? '2025-10-21' : '2026-04-12', homeTeam: String(index % 30), awayTeam: String((index + 1) % 30) }))
        expect(completeSeasonSchedule(games)).toBe(true)
        expect(completeSeasonSchedule(games.slice(1))).toBe(false)
        expect(completeSeasonSchedule(games.filter(game => game.homeTeam !== '29'))).toBe(false)
        expect(completeSeasonSchedule(games.map(game => ({ ...game, gameDate: '2025-10-21' })))).toBe(false)
    })
    it('refuses a date outside a supplied calendar', () => {
        expect(resolveSeasonWeekNumber(weeks, '2027-01-01', 'exact')).toBeNull()
    })
})
