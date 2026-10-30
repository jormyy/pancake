import './helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { SavedTradeEstimate } from '@/components/trades/SavedTradeEstimate'
import { PlayerRow } from '@/components/ui/PlayerRow'
import { PlayerSearchItem } from '@/components/PlayerSearchItem'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { Badge } from '@/components/ui/Badge'
import { normalizeTradeTab } from '@/lib/trade-ui-model'
import { playerAge } from '@/lib/player-context'
import { headerPlayer, playerRow, trade } from './helpers/fixtures'
vi.mock('@/hooks/use-league-timezone', () => ({ useLeagueTimezone: () => 'America/Los_Angeles' }))

vi.mock('@/lib/players', () => ({ getEligiblePositions: () => ['PG'] }))
let screen: ReactTestRenderer | undefined
afterEach(async () => { await act(async () => screen?.unmount()) })
const render = async (element: React.ReactElement) => {
    await act(async () => { screen = create(element) })
    return screen!
}
const estimate = {
    quoteId: 'quote', modelVersion: 'onenumber-trade-curve-v6', inputVersion: 'inputs', createdAt: '2026-10-27T20:37:50Z',
    teams: ['member-a', 'member-b'].map((memberId, index) => ({ memberId, valuesSent: index ? 605 : 1412,
        valuesReceived: index ? 1412 : 605, impact: index ? 677 : -677, shortTermPoints: 0,
        longTermValue: 0, rosterSlotEffect: 0, replacementEffect: 0, packageEffect: 0 })),
}

it.each([['member-a', 'Team A: 605 · Net -807'], ['member-b', 'Team B: 1412 · Net +807']])('shows the viewer side first for %s', async (myMemberId, expected) => {
    const tree = await render(React.createElement(SavedTradeEstimate, { trade: trade({ estimate }), myMemberId }))
    expect(tree.root.findAllByType('Text' as React.ElementType)[0].children.join('')).toBe(expected)
    expect(tree.root.findAllByProps({ accessibilityRole: 'button' })).toHaveLength(0)
})

it('omits a missing estimate', async () => {
    const tree = await render(React.createElement(SavedTradeEstimate, { trade: trade(), myMemberId: 'member-a' }))
    expect(tree.toJSON()).toBeNull()
})

it('keeps all four Trades sections in order and supports direct Analyzer links', () => {
    const source = readFileSync('app/(tabs)/trades.tsx', 'utf8')
    expect([...source.matchAll(/label: '(Offers|Block|History|Analyzer)', value: '(\w+)'/g)].map(match => [match[1], match[2]]))
        .toEqual([['Offers', 'offers'], ['Block', 'block'], ['History', 'history'], ['Analyzer', 'analyzer']])
    expect(normalizeTradeTab('analyzer')).toBe('analyzer')
    expect(normalizeTradeTab(['analyzer'])).toBe('analyzer')
})

it('puts age directly before experience in player rows', async () => {
    const tree = await render(React.createElement(PlayerRow, { name: 'Player', age: 30, yearsExp: 8 }))
    const badges = tree.root.findByProps({ testID: 'player-meta-line' }).findAllByType(Badge)
    expect(badges.slice(-2).map(badge => badge.props.label)).toEqual(['30', 'Yr 9'])
    expect(badges.at(-2)?.props.accessibilityLabel).toBe('Age 30')
})

it('puts age directly before experience in the profile', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
    try {
        const tree = await render(React.createElement(PlayerHeader, {
            player: headerPlayer({ birthdate: '1996-10-28', years_exp: 8 }), rosterStatus: null, leagueActive: false,
        }))
        expect(tree.root.findByProps({ testID: 'player-summary-line' }).findAllByType('Badge' as React.ElementType).map(badge => badge.props.label)).toEqual(['29', 'Yr 9'])
    } finally {
        vi.useRealTimers()
    }
})

it('calculates age at the birthday and omits unknown birthdates', () => {
    expect(playerAge('1996-10-28', new Date('2026-10-27T12:00:00Z'))).toBe(29)
    expect(playerAge('1996-10-28', new Date('2026-10-28T12:00:00Z'))).toBe(30)
    expect(playerAge('1996-10-28', new Date('2026-10-28T02:00:00Z'))).toBe(29)
    expect(playerAge(null)).toBeNull()
    expect(playerAge('invalid')).toBeNull()
})

it('passes age and experience from the Players list into the shared row', async () => {
    const tree = await render(React.createElement(PlayerSearchItem, {
        item: playerRow({ age: 30, years_exp: 8 }), currentMemberId: 'member-a', ownedMap: new Map(),
        waiverIds: new Set<string>(), isAdding: false, onAdd: () => {}, onPress: () => {},
    }))
    expect(tree.root.findByProps({ testID: 'player-meta-line' }).findAllByType(Badge).slice(-2).map(badge => badge.props.label)).toEqual(['30', 'Yr 9'])
})
