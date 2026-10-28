import { boundary } from '../helpers/screen-view-boundary'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it } from 'vitest'
import { useMatchupData } from '@/hooks/use-matchup-data'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('paints opponent and tip time in the first populated view without a follow-up read', async () => {
    boundary.read.mockResolvedValue({ context: { version: '1', league: { timezone: 'America/New_York' } }, matchup: {}, todaysGames: [{ id: 'game', home_team: 'CLE', away_team: 'WAS', status: 'Scheduled', game_time: '2026-10-28T23:00:00Z' }], teamMatchups: {}, liveStats: {}, startedTeams: [] })
    const frames: unknown[] = []
    const Probe = () => {
        const result = useMatchupData({ id: 'member' }, { id: 'account' }, { id: 'league' })
        const game = result.liveSnapshot.teamMatchups.get('WAS')
        if (game) frames.push(game)
        return null
    }
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(Probe)) })
    expect(boundary.read).toHaveBeenCalledTimes(1)
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every(frame => JSON.stringify(frame) === JSON.stringify({ opponent: 'CLE', isHome: false, gameTime: '2026-10-28T23:00:00Z', status: 'Scheduled', timezone: 'America/New_York' }))).toBe(true)
    await act(async () => screen.unmount())
})
