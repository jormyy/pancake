import { describe, expect, it } from 'vitest'
import { DEFAULT_LEAGUE_TIMEZONE, formatLeagueDate, formatLeagueTime, resolveLeagueTimezone } from '../../lib/timezone'

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
