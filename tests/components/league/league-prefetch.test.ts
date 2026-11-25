import { expect, it, vi } from 'vitest'
import { prefetchLeagueViews } from '@/components/league/prefetchLeagueViews'

const state = vi.hoisted(() => ({
    owner: 'account' as string | null | undefined,
    read: vi.fn(async () => ({})),
    scopes: [] as unknown[][],
}))

vi.mock('@/lib/cache/screen-cache', () => ({ readScreenView: state.read }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionOwner: () => state.owner }))
vi.mock('@/lib/cache/screen-scope', () => ({ screenScope: (...args: unknown[]) => { state.scopes.push(args); return { scope: args } } }))

it('warms every More view when the League tab opens', () => {
    state.owner = 'account'
    state.read.mockClear()
    state.scopes = []
    prefetchLeagueViews('league', 'member')
    expect(state.read).toHaveBeenCalledTimes(5)
    expect(state.scopes.map(args => args[3])).toEqual([
        { tab: 'history', limit: 20 },
        { tab: 'draftBoard', limit: 20 },
        { tab: 'seasons', limit: 20 },
        { tab: 'mockRooms', limit: 20 },
        { tab: 'settings', limit: 20 },
    ])
    expect(state.scopes.every(args => args[0] === 'league' && args[1] === 'league' && args[2] === 'member')).toBe(true)
})

it('reads nothing while signed out', () => {
    state.owner = null
    state.read.mockClear()
    prefetchLeagueViews('league', 'member')
    expect(state.read).not.toHaveBeenCalled()
})
