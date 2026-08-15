import { describe, expect, it } from 'vitest'

import { assertScheduleFresh, buildScheduleSyncPlan } from '@/core/src/season/schedule'

const staleSeason = [
  { gameId: '0022500001', gameDate: '2026-01-10', scheduleSeasonYear: '2025-26' },
  { gameId: '0022500002', gameDate: '2026-04-12', scheduleSeasonYear: '2025-26' },
]

describe('assertScheduleFresh offseason awareness', () => {
  it('returns offseason-stale for a stale payload between the last game and ~Sept 1', () => {
    expect(assertScheduleFresh(staleSeason, 2026, new Date('2026-06-15T16:00:00Z')))
      .toBe('offseason-stale')
    expect(assertScheduleFresh(staleSeason, 2026, new Date('2026-08-14T16:00:00Z')))
      .toBe('offseason-stale')
  })

  it('still fails for a genuinely stale in-season payload', () => {
    expect(() => assertScheduleFresh(staleSeason, 2026, new Date('2026-12-10T16:00:00Z')))
      .toThrow(/stale/)
    expect(() => assertScheduleFresh(staleSeason, 2026, new Date('2026-09-10T16:00:00Z')))
      .toThrow(/stale/)
  })

  it('returns fresh for a current payload', () => {
    expect(assertScheduleFresh(staleSeason, 2026, new Date('2026-03-01T16:00:00Z')))
      .toBe('fresh')
  })

  it('still fails on a season-label mismatch regardless of date', () => {
    const mislabeled = staleSeason.map((game) => ({ ...game, scheduleSeasonYear: '2024-25' }))
    expect(() => assertScheduleFresh(mislabeled, 2026, new Date('2026-06-15T16:00:00Z')))
      .toThrow(/does not match/)
  })
})

describe('buildScheduleSyncPlan offseason skip', () => {
  const rawGames = staleSeason.map((game) => ({
    ...game,
    homeTeam: 'AAA',
    awayTeam: 'BBB',
    status: 'Final',
    startedAt: null,
    weekNumber: 1,
  }))

  it('produces an empty skip plan instead of throwing in the offseason window', () => {
    const plan = buildScheduleSyncPlan(rawGames, new Date('2026-06-15T16:00:00Z'))
    expect(plan.offseasonStale).toBe(true)
    expect(plan.rows).toHaveLength(0)
    expect(plan.weeks).toHaveLength(0)
  })

  it('throws for the same stale payload in-season', () => {
    expect(() => buildScheduleSyncPlan(rawGames, new Date('2026-12-10T16:00:00Z')))
      .toThrow(/stale/)
  })
})
