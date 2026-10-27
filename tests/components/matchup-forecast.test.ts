import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MatchupForecastSummary } from '@/components/MatchupForecastSummary'
import type { MatchupForecast } from '@/hooks/use-matchup-forecast'

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', StyleSheet: { create: (value: unknown) => value } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const text = () => screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children).flat().join(' ')
afterEach(async () => { await act(async () => screen?.unmount()) })
const forecast = (): MatchupForecast => ({
    matchupId: 'matchup', modelVersion: 'independent-games-v1', status: 'available', stale: false,
    calculatedAt: '2026-10-25T19:30:00Z', inputRevision: 1, lineupBasis: 'Saved lineups and enabled automatic lineups',
    teams: [
        { memberId: 'mine', currentPoints: 5, projectedFinal: 42.5, winProbability: 0.73, remainingGames: 2, coveredGames: 2, variance: 10 },
        { memberId: 'other', currentPoints: 10, projectedFinal: 35.2, winProbability: 0.27, remainingGames: 1, coveredGames: 1, variance: 10 },
    ], tieProbability: 0, missingInputs: [], games: [],
})
const render = async (value: MatchupForecast | null, stale = false, pending = false) => act(async () => {
    screen = create(React.createElement(MatchupForecastSummary, { forecast: value, stale, pending, error: false, myMemberId: 'mine', opponentMemberId: 'other' }))
})
it('shows shared final points and odds next to each team', async () => {
    await render(forecast())
    expect(text()).toContain('42.5 FP projected')
    expect(text()).toContain('73% win')
    expect(text()).toContain('35.2 FP projected')
    expect(text()).toContain('27% win')
    expect(text()).toContain('Updated')
    expect(text()).toContain('Saved lineups')
})
it('never invents odds or points when inputs are missing', async () => {
    const value = forecast()
    value.status = 'limited'
    value.teams = value.teams.map(team => ({ ...team, projectedFinal: null, winProbability: null, coveredGames: 0 }))
    value.missingInputs = ['Projection unavailable: secret-player-id']
    await render(value)
    expect(text()).toContain('Projection unavailable')
    expect(text()).toContain('Win odds unavailable')
    expect(text()).toContain('Limited forecast')
    expect(text()).not.toContain('50%')
    expect(text()).not.toContain('0.0 FP')
    expect(text()).not.toContain('secret-player-id')
})
it('labels retained estimates stale during refresh', async () => {
    await render(forecast(), true, true)
    expect(text()).toContain('42.5 FP projected')
    expect(text()).toContain('Forecast out of date')
})
it('shows a missing cache without fabricated values', async () => {
    await render(null)
    expect(text()).toContain('Forecast unavailable')
    expect(text()).not.toContain('% win')
})
