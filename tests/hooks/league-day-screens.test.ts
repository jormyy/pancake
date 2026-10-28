import { boundary } from '../helpers/screen-view-boundary'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useScreenView } from '@/hooks/use-screen-view'
import { screenScope } from '@/lib/cache/screen-scope'
import { rememberLeagueTimezone } from '@/lib/league-timezones'
import type { ScreenName } from '@/lib/cache/screen-cache'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer | undefined
function Surface({ name, section }: { name: ScreenName; section: string }) {
    const scope = screenScope(name, 'league', 'member', { section }, 'account')
    const view = useScreenView<{ day: string }>(scope)
    return React.createElement('Result', { day: scope.params?.date, loadedDay: view.data?.day })
}
afterEach(async () => { if (screen) await act(async () => screen!.unmount()); screen = undefined })

it.each([
    ['Home', 'home'], ['Roster', 'roster'], ['Players', 'players'],
    ['Waivers', 'roster'], ['Lineup', 'lineup'], ['Matchup', 'home'],
] as const)('%s stays on Tuesday at 9:21 PM Pacific and reloads Wednesday by 12:01 AM', async (section, name) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-28T04:21:00Z'))
    rememberLeagueTimezone('league', 'America/Los_Angeles')
    boundary.read.mockImplementation(async scope => ({ day: scope.params.date }))
    await act(async () => { screen = create(React.createElement(Surface, { name, section })) })
    expect(screen!.root.findByType('Result' as React.ElementType).props).toMatchObject({ day: '2026-10-27', loadedDay: '2026-10-27' })
    await act(async () => { await vi.advanceTimersByTimeAsync(160 * 60_000) })
    expect(new Date().toISOString()).toBe('2026-10-28T07:01:00.000Z')
    expect(screen!.root.findByType('Result' as React.ElementType).props).toMatchObject({ day: '2026-10-28', loadedDay: '2026-10-28' })
    expect(boundary.read).toHaveBeenLastCalledWith(expect.objectContaining({ params: expect.objectContaining({ date: '2026-10-28' }) }))
})

it('keeps different league days isolated at the same instant', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-28T04:21:00Z'))
    rememberLeagueTimezone('west', 'America/Los_Angeles')
    rememberLeagueTimezone('east', 'Asia/Tokyo')
    expect(screenScope('home', 'west', 'member').params?.date).toBe('2026-10-27')
    expect(screenScope('home', 'east', 'member').params?.date).toBe('2026-10-28')
})
