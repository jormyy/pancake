import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: {} }))
import { formatProjectionGame } from '@/lib/projections'

const originalTimezone = process.env.TZ
afterEach(() => {
    if (originalTimezone === undefined) delete process.env.TZ
    else process.env.TZ = originalTimezone
})

it.each(['Pacific/Auckland', 'UTC', 'America/Los_Angeles'])(
    'displays the stored game date in %s', (timezone) => {
        process.env.TZ = timezone
        expect(formatProjectionGame({
            projection_date: '2026-10-20', next_game_date: '2026-10-21', next_game_opponent: 'BOS',
        })).toBe('BOS Oct 20')
        expect(formatProjectionGame({
            projection_date: null, next_game_date: '2026-01-01', next_game_opponent: null,
        })).toBe('Jan 1')
    },
)

it('keeps missing and invalid date fallbacks visible', () => {
    expect(formatProjectionGame({ projection_date: null, next_game_date: null, next_game_opponent: 'BOS' })).toBe('BOS')
    expect(formatProjectionGame({ projection_date: 'invalid', next_game_date: null, next_game_opponent: null })).toBe('invalid')
})
