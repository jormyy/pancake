import { describe, expect, it, vi } from 'vitest'
import { playerHeadshotUrl } from '@/lib/format'

vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:54321/functions/v1/api' }))

describe('playerHeadshotUrl', () => {
    it('routes through the /players/headshot proxy, not the direct CDN', () => {
        expect(playerHeadshotUrl('1629018')).toBe('http://127.0.0.1:54321/functions/v1/api/players/headshot/1629018')
    })

    it('returns null when nbaId is absent (avatar falls back to initials)', () => {
        expect(playerHeadshotUrl(null)).toBeNull()
    })
})
