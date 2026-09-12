// Which surface the Home play area shows. Kept pure so the precedence is
// testable: a live draft always wins (the manager must get to the draft room
// even when the matchup refresh failed), then a real matchup, then loading,
// then a failed load, and only then the true "no matchup" empty state.
export type HomeSurface = 'draft' | 'matchup' | 'loading' | 'error' | 'empty'

export function resolveHomeSurface(input: {
    leagueStatus: string | null | undefined
    hasMatchup: boolean
    loading: boolean
    error: string | null | undefined
}): HomeSurface {
    if (input.hasMatchup) return 'matchup'
    if (input.leagueStatus === 'drafting') return 'draft'
    if (input.loading) return 'loading'
    if (input.error) return 'error'
    return 'empty'
}
