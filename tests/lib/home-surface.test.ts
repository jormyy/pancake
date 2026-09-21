import { describe, expect, it } from 'vitest'
import { resolveHomeSurface } from '@/lib/home-surface'

// Review S4: the live-draft card must win over a failed refresh, and a failed
// refresh must never be shown as "no matchup".
describe('resolveHomeSurface', () => {
    const base = { leagueStatus: 'active', hasMatchup: false, loading: false, error: null }

    it('shows the matchup whenever one is loaded, even with a stale error', () => {
        expect(resolveHomeSurface({ ...base, hasMatchup: true, error: 'Failed to load matchup' })).toBe('matchup')
    })

    it('keeps the live-draft card ahead of loading and error', () => {
        expect(resolveHomeSurface({ ...base, leagueStatus: 'drafting', loading: true })).toBe('draft')
        expect(resolveHomeSurface({ ...base, leagueStatus: 'drafting', error: 'Failed to load matchup' })).toBe('draft')
    })

    it('renders a failed load as an error, never as an empty week', () => {
        expect(resolveHomeSurface({ ...base, error: 'Failed to load matchup' })).toBe('error')
        expect(resolveHomeSurface({ ...base, loading: true, error: 'Failed to load matchup' })).toBe('loading')
    })

    it('shows the empty week only when nothing failed', () => {
        expect(resolveHomeSurface(base)).toBe('empty')
        expect(resolveHomeSurface({ ...base, leagueStatus: undefined })).toBe('empty')
    })
})
