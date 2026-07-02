import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function shouldShowScoreboard(selectedDate: string, today: string): boolean {
    return selectedDate === today
}

function shouldShowErrorBanner(error: string | null | undefined): boolean {
    return error != null
}

describe('shouldShowScoreboard', () => {
    it('returns true when selectedDate equals today', () => {
        expect(shouldShowScoreboard('2026-05-25', '2026-05-25')).toBe(true)
    })

    it('returns false when selectedDate is a past date', () => {
        expect(shouldShowScoreboard('2026-05-24', '2026-05-25')).toBe(false)
    })

    it('returns false when selectedDate is a future date', () => {
        expect(shouldShowScoreboard('2026-05-26', '2026-05-25')).toBe(false)
    })
})

describe('shouldShowErrorBanner', () => {
    it('returns true when error is a non-null string', () => {
        expect(shouldShowErrorBanner('Failed to load matchup')).toBe(true)
    })

    it('returns false when error is null', () => {
        expect(shouldShowErrorBanner(null)).toBe(false)
    })

    it('returns false when error is undefined', () => {
        expect(shouldShowErrorBanner(undefined)).toBe(false)
    })
})

describe('home matchup instant cache', () => {
    it('hydrates same-day matchup and lineup data from persistent cache before refresh', () => {
        const source = readFileSync(path.join(process.cwd(), 'hooks/use-matchup-data.ts'), 'utf8')

        expect(source).toContain("MATCHUP_CACHE_PREFIX = 'pancake:home-matchup:v1:'")
        expect(source).toContain('readMatchupCache(current?.id, leagueId)')
        expect(source).toContain('cached.today !== todayET()')
        expect(source).toContain('useState<Matchup | null | undefined>(initialCache?.matchup ?? undefined)')
        expect(source).toContain('useState(!initialCache)')
        expect(source).toContain('setMatchupLoading(!hasVisibleMatchup)')
        expect(source).toContain('writeMatchupCache(current.id, leagueId')
    })
})
