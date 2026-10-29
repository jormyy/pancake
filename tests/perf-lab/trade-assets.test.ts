import { beforeEach, expect, it, vi } from 'vitest'
import { tradeScenarios } from '../../scripts/season-sim/trade-scenarios.mjs'
import { sql, sqlJson } from '../../scripts/season-sim/local-stack.mjs'

vi.mock('../../scripts/season-sim/local-stack.mjs', () => ({ sql: vi.fn(), sqlJson: vi.fn() }))

beforeEach(() => vi.resetAllMocks())

it.each([2026, 2030])('uses an existing pick inside the %i season window for a deadline rejection', async seasonYear => {
  const api = vi.fn(async () => ({ error: 'Trade deadline has passed' }))
  const context = { seasonYear, leagueId: 'league', users: [{ memberId: 'a' }, { memberId: 'b' }], api }
  const report = { tradeDeadline: { deadline: '2025-10-22', pendingPick: 'offer', pendingTrade: 'pending' }, completed: [] }
  vi.mocked(sql).mockResolvedValue('pending')
  vi.mocked(sqlJson).mockResolvedValue([
    { id: 'current', season_year: seasonYear, round: 1 },
    ...[3, 2, 1].map(offset => ({ id: `recipient-${seasonYear + offset}`, season_year: seasonYear + offset, round: 1 })),
  ])
  await tradeScenarios(context, report, vi.fn())('2025-10-23')
  expect(api).toHaveBeenNthCalledWith(1, context.users[0], '/trades/propose', expect.objectContaining({ requestPickIds: [`recipient-${seasonYear + 1}`] }), 400)
  expect(report.tradeDeadline).toMatchObject({ postDeadlinePassed: true, pendingStatus: 'pending' })
})

it('does not fabricate a recipient pick when no unlocked asset exists', async () => {
  vi.mocked(sqlJson).mockResolvedValue([])
  const api = vi.fn()
  const context = { seasonYear: 2026, leagueId: 'league', users: [{ memberId: 'a' }, { memberId: 'b' }], api }
  const report = { tradeDeadline: { deadline: '2025-10-22', pendingPick: 'offer', pendingTrade: 'pending' }, completed: [] }
  await expect(tradeScenarios(context, report, vi.fn())('2025-10-23')).rejects.toThrow('Trade requires a real recipient asset')
  expect(api).not.toHaveBeenCalled()
})
