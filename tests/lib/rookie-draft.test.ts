import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ from: vi.fn(), apiPost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: mocks.from, removeChannel: vi.fn() } }))
vi.mock('@/lib/shared/api', () => ({ apiPost: mocks.apiPost }))
vi.mock('@/lib/realtime', () => ({ subscribeToTableChanges: vi.fn(), unsubscribeFromTableChanges: vi.fn() }))

import { validateRookieTimerSeconds } from '@/lib/draft-options'
import { startRookieDraft } from '@/lib/rookieDraft'

beforeEach(() => vi.clearAllMocks())

describe('rookie draft startup', () => {
    it('normalizes the real server draft type for room navigation', async () => {
        mocks.apiPost.mockResolvedValue({ draft: { id: 'annual', draft_type: 'snake' } })
        const result = await startRookieDraft('league', { timerSeconds: 600, rounds: 3 })
        expect(result.draft).toMatchObject({ id: 'annual', draftType: 'snake' })
    })
})

describe('rookie timer range', () => {
    it.each([60, 604800])('accepts %s seconds', value => {
        expect(validateRookieTimerSeconds(value)).toBe(value)
    })
    it.each([5, 30, 59, 604801, 60.5, NaN])('rejects %s before a request', async value => {
        await expect(startRookieDraft('league', { timerSeconds: value })).rejects.toThrow('1 minute and 7 days')
        expect(mocks.apiPost).not.toHaveBeenCalled()
    })
})
