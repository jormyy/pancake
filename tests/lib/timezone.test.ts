import { describe, expect, it } from 'vitest'
import { todayLeague, endOfLeagueDayUTC, DEFAULT_LEAGUE_TIMEZONE, formatLeagueDate, formatLeagueTime, resolveLeagueTimezone } from '../../lib/timezone'

describe('league timezone formatting', () => {
  it('uses Los Angeles and accepts IANA timezone names', () => {
    expect(DEFAULT_LEAGUE_TIMEZONE).toBe('America/Los_Angeles')
    expect(resolveLeagueTimezone('Europe/London')).toBe('Europe/London')
    expect(resolveLeagueTimezone('Invalid/City')).toBe(DEFAULT_LEAGUE_TIMEZONE)
  })
  it('formats the same instant on the correct local day', () => {
    expect(formatLeagueDate('2026-01-02T03:00:00Z')).toBe('Jan 1, 2026')
    expect(formatLeagueDate('2026-01-02T03:00:00Z', 'Asia/Tokyo')).toBe('Jan 2, 2026')
  })
  it('preserves calendar dates without inventing a timezone offset', () => {
    expect(formatLeagueDate('2026-11-02')).toBe('Nov 2, 2026')
    expect(formatLeagueDate('2026-02-30')).toBe('unknown')
  })
  it('handles daylight saving transitions', () => {
    expect(formatLeagueTime('2026-03-08T09:30:00Z')).toBe('1:30 AM')
    expect(formatLeagueTime('2026-03-08T10:30:00Z')).toBe('3:30 AM')
    expect(formatLeagueDate('invalid')).toBe('unknown')
  })
})

it('keeps Tuesday at 9:21 PM Pacific and flips at local midnight', () => {
  expect(todayLeague(undefined, new Date('2026-10-28T04:21:00Z'))).toBe('2026-10-27')
  expect(todayLeague('America/New_York', new Date('2026-10-28T04:21:00Z'))).toBe('2026-10-28')
  expect(todayLeague(undefined, new Date('2026-10-28T07:00:00Z'))).toBe('2026-10-28')
  expect(endOfLeagueDayUTC('2026-10-27')).toBe('2026-10-28T06:59:59.999Z')
  expect(endOfLeagueDayUTC('2026-03-08')).toBe('2026-03-09T06:59:59.999Z')
  expect(endOfLeagueDayUTC('2026-11-01')).toBe('2026-11-02T07:59:59.999Z')
})
