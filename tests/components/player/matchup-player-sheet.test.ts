import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MatchupPlayerSheet } from '@/components/player/MatchupPlayerSheet'
import type { LineupPlayer } from '@/lib/lineup'
import { getRosterStatsMaps } from '@/lib/roster-stats'

vi.mock('@/lib/roster-stats', () => ({ getRosterStatsMaps: vi.fn() }))
vi.mock('@/components/player/PlayerPreviewSheet', () => ({ PlayerPreviewSheet: 'PlayerPreviewSheet' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const player = { rosterPlayerId: 'r1', playerId: 'p1', displayName: 'Austin Reaves', position: 'SG', eligiblePositions: ['PG', 'SG'],
    nbaTeam: 'LAL', injuryStatus: null, nbaId: '1630559', yearsExp: 4 } as LineupPlayer
const stats = { avg_minutes_played: 34.2, avg_points: 20.1 } as never
let screen: ReactTestRenderer | undefined

afterEach(async () => { await act(async () => screen?.unmount()); screen = undefined; vi.clearAllMocks() })

function sheet() { return screen!.root.findByType('PlayerPreviewSheet' as React.ElementType) }

it('previews the tapped player with season averages and a player page action', async () => {
    vi.mocked(getRosterStatsMaps).mockResolvedValue({ avgMap: new Map([['p1', 38.4]]), avgStatsMap: new Map([['p1', stats]]) })
    const onOpenPage = vi.fn()
    const onClose = vi.fn()
    await act(async () => { screen = create(React.createElement(MatchupPlayerSheet, { player, leagueId: 'league', onOpenPage, onClose })) })
    expect(getRosterStatsMaps).toHaveBeenCalledWith(['p1'], 'league')
    expect(sheet().props.player).toMatchObject({ name: 'Austin Reaves', team: 'LAL', positions: ['PG', 'SG'], yearsExp: 4 })
    expect(sheet().props.avgFpts).toBe(38.4)
    expect(sheet().props.stats).toBe(stats)
    const actions = sheet().props.actions as { key: string; onPress: () => void }[]
    expect(actions.map(action => action.key)).toEqual(['page'])
    await act(async () => actions[0].onPress())
    expect(onClose).toHaveBeenCalledOnce()
    expect(onOpenPage).toHaveBeenCalledWith(player)
})

it('stays closed without a player and never shows stale averages for the next player', async () => {
    vi.mocked(getRosterStatsMaps).mockResolvedValue({ avgMap: new Map([['p1', 38.4]]), avgStatsMap: new Map() })
    const props = { leagueId: 'league', onOpenPage: vi.fn(), onClose: vi.fn() }
    await act(async () => { screen = create(React.createElement(MatchupPlayerSheet, { ...props, player: null })) })
    expect(sheet().props.player).toBeNull()
    expect(getRosterStatsMaps).not.toHaveBeenCalled()
    await act(async () => screen!.update(React.createElement(MatchupPlayerSheet, { ...props, player })))
    expect(sheet().props.avgFpts).toBe(38.4)
    vi.mocked(getRosterStatsMaps).mockReturnValue(new Promise(() => {}))
    await act(async () => screen!.update(React.createElement(MatchupPlayerSheet, { ...props, player: { ...player, playerId: 'p2' } })))
    expect(sheet().props.avgFpts).toBeUndefined()
})
