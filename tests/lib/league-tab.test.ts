import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase before importing anything that uses it
vi.mock('@/lib/supabase', () => ({
    supabase: { from: vi.fn(), rpc: vi.fn() },
}))

vi.mock('@/lib/players', () => ({
    getEligiblePositions: vi.fn(() => []),
    getPlayerRowMetadata: vi.fn(async () => new Map()),
}))
import { LEAGUE_TABS, parseLeagueTab } from '@/lib/league/tabs'

beforeEach(() => {
    vi.clearAllMocks()
})

describe('parseLeagueTab', () => {
    it('accepts known league tabs and falls back to results', () => {
        for (const { key } of LEAGUE_TABS) {
            expect(parseLeagueTab(key)).toBe(key)
        }
        expect(LEAGUE_TABS.find(tab => tab.key === 'bracket')?.label).toBe('Playoffs')
        expect(parseLeagueTab('playoffs')).toBe('bracket')
        expect(parseLeagueTab('not-a-tab')).toBe('results')
        expect(parseLeagueTab(undefined)).toBe('results')
    })
})
