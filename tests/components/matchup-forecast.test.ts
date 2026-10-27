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
    expect(text()).toContain('43 proj')
    expect(text()).toContain('73% win')
    expect(text()).toContain('35 proj')
    expect(text()).toContain('27% win')
    expect(text()).not.toContain('Updated')
    expect(text()).not.toContain('Saved lineups')
})
it('never invents odds or points when inputs are missing', async () => {
    const value = forecast()
    value.status = 'limited'
    value.teams = value.teams.map(team => ({ ...team, projectedFinal: null, winProbability: null, coveredGames: 0 }))
    value.missingInputs = ['Projection unavailable: secret-player-id']
    await render(value)
    expect(text()).toContain('— proj')
    expect(text()).toContain('— win')
    expect(text()).not.toContain('Limited forecast')
    expect(text()).not.toContain('50%')
    expect(text()).not.toContain('0.0 FP')
    expect(text()).not.toContain('secret-player-id')
})
it('keeps retained estimates compact during refresh', async () => {
    await render(forecast(), true, true)
    expect(text()).toContain('43 proj')
    expect(text()).not.toContain('Forecast out of date')
})
it('shows a missing cache without fabricated values', async () => {
    await render(null)
    expect(text()).toContain('— proj')
    expect(text()).toContain('— win')
    expect(text()).not.toContain('% win')
})

it('withholds both odds when either final projection is missing', async () => {
    const value = forecast()
    value.teams[1].projectedFinal = null
    await render(value)
    expect(text()).not.toContain('% win')
    expect(text()).toContain('— win')
})
it('uses current scores plus remaining projections for both teams', async () => {
    const { estimateMatchup } = await import('@pancake/core')
    const value = forecast()
    const scores = [{ memberId: 'mine', currentPoints: 322 }, { memberId: 'other', currentPoints: 309 }]
    const games = [{ gameId: 'a', playerId: 'a', memberId: 'mine', expectedPoints: 1394, variance: 10000, completed: false, eligible: true },
        { gameId: 'b', playerId: 'b', memberId: 'other', expectedPoints: 1460, variance: 10000, completed: false, eligible: true }]
    const estimate = estimateMatchup(scores, games)
    await render({ ...value, ...estimate })
    expect(text()).toContain('1716 proj')
    expect(text()).toContain('1769 proj')
    expect(text()).toContain(`${Math.round(estimate.teams[0].winProbability! * 100)}% win`)
    expect(estimate.teams[0].winProbability).toBeLessThan(0.5)
})
