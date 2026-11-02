import { boundary } from '../helpers/screen-view-boundary'
import { homeHarness, homePayload } from '../helpers/home-view-fixture'
import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ enabled: false }))
vi.mock('@/hooks/use-public-live-snapshot', () => ({ usePublicLiveSnapshot: (_date: string, _games: unknown[], enabled: boolean) => {
    state.enabled = enabled
    return { active: enabled, snapshot: null }
} }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = homeHarness()
it('keeps an unfinished selected matchup eligible after league midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-10-30T08:05:00Z'))
    boundary.read.mockResolvedValue({ ...homePayload('2026-10-29'),
        todaysGames: [{ nba_game_id: '0021', game_date: '2026-10-29', status: 'InProgress', game_time: '2026-10-30T02:00:00Z' }],
        liveBasis: [{ id: 'matchup', finalized: false, players: [{ playerId: 'p', gameId: '0021' }] }],
    })
    await h.render()
    expect(h.latest.selectedDate).toBe('2026-10-29')
    expect(state.enabled).toBe(true)
})
