import { describe, expect, it } from 'vitest'
import { read } from '../source-guard'

// Regression guard: player headshots must route through the app's Edge proxy
// (/players/headshot/:nbaId), not a direct cdn.nba.com URL — the CDN blocks the
// image cross-origin in the browser, so a direct URL silently degrades every
// avatar to initials. See the Dynasty Hub, which already used the proxy path.
// (Source-guarded rather than imported: lib/format pulls in react-native via
// lib/shared/api, which the vitest env can't load.)
describe('playerHeadshotUrl', () => {
    const format = read('lib/format.ts')

    it('routes through the /players/headshot proxy, not the direct CDN', () => {
        expect(format).toContain('/players/headshot/${nbaId}')
        expect(format).toContain("import { API_URL } from '@/lib/shared/api'")
        expect(format).not.toContain('cdn.nba.com/headshots')
    })

    it('returns null when nbaId is absent (avatar falls back to initials)', () => {
        expect(format).toMatch(/if \(!nbaId\) return null/)
    })
})
