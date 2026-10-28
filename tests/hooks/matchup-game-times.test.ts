import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it } from 'vitest'
import { useMatchupGameTimes } from '@/hooks/use-matchup-game-times'
import type { NBAGameRow } from '@/lib/games'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('uses only the supplied view and removes old times when the slate changes', async () => {
    const frames: ReturnType<typeof useMatchupGameTimes>[] = []
    const Probe = ({ games }: { games: NBAGameRow[] }) => { frames.push(useMatchupGameTimes(games, 'America/New_York')); return null }
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(Probe, { games: [{ id: 'game', game_time: '2026-10-28T23:00:42Z' } as NBAGameRow] })) })
    expect(frames).toHaveLength(1)
    expect(frames[0].values.get('game')).toBe('2026-10-28T23:00:42Z')
    expect(frames[0].timezone).toBe('America/New_York')
    await act(async () => screen.update(React.createElement(Probe, { games: [] })))
    expect(frames.at(-1)?.values.size).toBe(0)
    await act(async () => screen.unmount())
})
