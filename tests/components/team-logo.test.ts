import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { TeamLogo, teamLogoUrl } from '@/components/TeamLogo'

vi.mock('react-native', () => ({ Image: 'Image', Text: 'Text' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
afterEach(async () => { await act(async () => screen?.unmount()) })

it.each([['BOS', 'bos'], ['GSW', 'gs'], ['NOP', 'no'], ['NYK', 'ny'], ['SAS', 'sa'], ['UTA', 'utah'], ['WAS', 'wsh'], [' phx ', 'phx']])('maps %s to the ESPN %s logo', (team, code) => {
    expect(teamLogoUrl(team)).toBe(`https://a.espncdn.com/combiner/i?img=/i/teamlogos/nba/500/${code}.png&w=64&h=64`)
})

it.each([null, undefined, '', 'FA', 'XYZ'])('has no logo for %s', team => {
    expect(teamLogoUrl(team)).toBeNull()
})

it('shows the logo at text size, labelled with the team', async () => {
    await act(async () => { screen = create(React.createElement(TeamLogo, { team: 'MEM', size: 14 })) })
    const image = screen.root.findByType('Image' as React.ElementType)
    expect(image.props.style).toEqual({ width: 14, height: 14, flexShrink: 0 })
    expect(image.props.accessibilityLabel).toBe('MEM')
})

it('falls back to the abbreviation for unknown teams and failed images', async () => {
    await act(async () => { screen = create(React.createElement(TeamLogo, { team: 'XYZ', size: 14 })) })
    expect(screen.root.findByType('Text' as React.ElementType).props.children).toBe('XYZ')
    await act(async () => screen.update(React.createElement(TeamLogo, { key: 'MEM', team: 'MEM', size: 14 })))
    await act(async () => screen.root.findByType('Image' as React.ElementType).props.onError())
    expect(screen.root.findByType('Text' as React.ElementType).props.children).toBe('MEM')
    expect(screen.root.findAllByType('Image' as React.ElementType)).toHaveLength(0)
})
