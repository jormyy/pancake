import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { PlayerAvatar } from '@/components/player/PlayerAvatar'
import { playerDetailRoute, readPlayerHeader } from '@/components/player/navigation'
import { playerRow } from '@/tests/helpers/fixtures'
import { playerHeadshotUrl } from '@/lib/format'

vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/lib/format', () => ({ playerHeadshotUrl: vi.fn((id: string) => `/players/headshot/${id}`) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer | undefined
afterEach(async () => { await act(async () => screen?.unmount()); vi.clearAllMocks() })

it.each([undefined, null, 'IOS223', '12', '12345678901', '../123'])('keeps initials without requesting an unusable NBA image: %s', async nbaId => {
    await act(async () => { screen = create(React.createElement(PlayerAvatar, { name: 'Player A', nbaId })) })
    expect(playerHeadshotUrl).not.toHaveBeenCalled()
    expect(screen!.root.findByType('Avatar' as React.ElementType).props.uri).toBeNull()
})

it('keeps the same avatar mounted when its headshot becomes available', async () => {
    const props = { name: 'Player A', size: 40 }
    await act(async () => { screen = create(React.createElement(PlayerAvatar, props)) })
    const initial = screen!.root.findByType('Avatar' as React.ElementType)
    await act(async () => screen!.update(React.createElement(PlayerAvatar, { ...props, nbaId: '1629029' })))
    const updated = screen!.root.findByType('Avatar' as React.ElementType)
    expect(updated).toBe(initial)
    expect(updated.props.uri).toBe('/players/headshot/1629029')
    expect(updated.props.size).toBe(props.size)
})

it('carries the tapped identity into the first detail render without sending list statistics', () => {
    const player = playerRow({ display_name: 'Name & number 12', injury_status: 'Out', avg_fantasy_points: 42 })
    const route = playerDetailRoute(player)
    expect(route.pathname).toBe('/player/[id]')
    expect(route.params.id).toBe(player.id)
    expect(readPlayerHeader(player.id, route.params.playerHeader)).toMatchObject({
        id: player.id, display_name: player.display_name, injury_status: 'Out',
        nba_team: player.nba_team, eligible_positions: player.eligible_positions,
    })
    expect(JSON.parse(route.params.playerHeader)).not.toHaveProperty('avg_fantasy_points')
})
