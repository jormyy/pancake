import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach } from 'vitest'
import { usePlayerScreenData } from '@/hooks/use-player-screen-data'
import { seasonLine } from '@/tests/components/player/season-fixtures'
import { currentSeasonYear } from '@/lib/shared/season'

export function playerPayload(playerId = 'player', count = 1, points = 22) {
    return { context: { version: '1' }, player: { id: playerId, display_name: playerId, nba_team: 'LAL' }, availableSeasons: [currentSeasonYear(), currentSeasonYear() - 1], averages: null, avgFantasyPoints: null, lines: Array.from({ length: count }, (_, index) => seasonLine({ id: `stat-${index}`, points, nba_games: { ...seasonLine().nba_games, id: `game-${index}` } })), nextProjection: { player_id: playerId, projection_fantasy_points: points }, transactions: [], scoringSettings: { points: 1 } }
}
export function playerHarness() {
    let latest!: ReturnType<typeof usePlayerScreenData>, screen: ReactTestRenderer | undefined
    const frames: ReturnType<typeof usePlayerScreenData>[] = []
    const Probe = ({ player = 'player', member = 'member', authorized = true }: { player?: string; member?: string; authorized?: boolean }) => { latest = usePlayerScreenData(player, 'league', { ownerKey: JSON.stringify(['account', member]), authorized }); frames.push(latest); return null }
    const render = async (props = {}) => { await act(async () => { if (screen) screen.update(React.createElement(Probe, props)); else screen = create(React.createElement(Probe, props)) }); await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)) }) }
    afterEach(async () => { await act(async () => screen?.unmount()); screen = undefined; frames.length = 0 })
    return { get latest() { return latest }, frames, render }
}
