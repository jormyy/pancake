import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AuctionLivePanel } from '@/components/league/draft-room/AuctionLivePanel'
import { formatCountdown } from '@/lib/format'

vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, View: 'View', Text: 'Text', TextInput: 'TextInput',
    StyleSheet: { create: (value: unknown) => value },
}))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/TaxiAcquisitionChoice', () => ({ TaxiAcquisitionChoice: 'TaxiAcquisitionChoice' }))
vi.mock('@/components/Motion', () => ({ MotionPressable: 'MotionPressable' }))
vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:57121/functions/v1/api' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Controller = React.ComponentProps<typeof AuctionLivePanel>['controller']
const flatten = (style: unknown): Record<string, unknown> => Object.assign({}, ...[style].flat(Infinity).filter(Boolean))
let screen: ReactTestRenderer
let controller: Controller
const tree = () => React.createElement(AuctionLivePanel, { controller: { ...controller }, memberId: 'me', compact: false })
beforeEach(() => {
    controller = {
        state: {
            draft: { status: 'in_progress', isMock: false }, activeBids: [],
            openNomination: { currentBidAmount: 1, currentBidderId: 'other', nominatingMemberId: 'other',
                player: { displayName: 'A player', nbaTeam: 'LAL', position: 'PG' } },
        },
        budgetByMember: new Map([['me', { remaining: 200 }], ['other', { teamName: 'Other team' }]]),
        bidText: '2', timeLeft: 59, realtimeConnected: false, actionsReady: true,
    } as unknown as Controller
})
afterEach(async () => { await act(async () => screen?.unmount()) })

it('keeps bid controls mounted while the first live connection arrives', async () => {
    await act(async () => { screen = create(tree()) })
    const input = screen.root.findByType('TextInput' as React.ElementType)
    const first = screen.toJSON()
    expect(input.props.accessibilityLabel).toBe('Bid amount')
    expect(input.props.editable).toBe(false)
    const button = screen.root.findByProps({ accessibilityLabel: 'Bid $2' })
    expect(button.props.disabled).toBe(true)
    controller.realtimeConnected = true
    await act(async () => { screen.update(tree()) })
    expect(screen.root.findByType('TextInput' as React.ElementType)).toBe(input)
    expect(input.props.editable).toBe(true)
    expect(button.props.disabled).toBe(false)
    expect(JSON.stringify(first)).not.toContain('Bidding unlocks')
})

it('does not show a connection paragraph to the current leading bidder', async () => {
    controller.state!.openNomination!.currentBidderId = 'me'
    await act(async () => { screen = create(tree()) })
    expect(JSON.stringify(screen.toJSON())).not.toContain('Bidding unlocks')
    expect(screen.root.findAllByType('TextInput' as React.ElementType)).toHaveLength(0)
})

it('reserves the clock width and keeps borders the same size when the clock becomes urgent', async () => {
    controller.realtimeConnected = true
    controller.timeLeft = 11
    await act(async () => { screen = create(tree()) })
    const clock = () => screen.root.findAllByType('Text' as React.ElementType)
        .find(node => node.props.children === formatCountdown(controller.timeLeft))!
    const regularClock = flatten(clock().parent!.props.style)
    const regularCard = flatten(screen.root.findAllByType('View' as React.ElementType)[0].props.style)
    expect(regularClock.width).toEqual(expect.any(Number))
    expect(flatten(clock().props.style).width).toBe('100%')
    controller.timeLeft = 10
    await act(async () => { screen.update(tree()) })
    expect(flatten(clock().parent!.props.style).width).toBe(regularClock.width)
    expect(flatten(clock().parent!.props.style).borderWidth).toBe(regularClock.borderWidth)
    expect(flatten(screen.root.findAllByType('View' as React.ElementType)[0].props.style).borderWidth)
        .toBe(regularCard.borderWidth)
})

it('places age immediately before experience in the live draft player row', async () => {
    controller.state!.openNomination!.player!.age = 25
    controller.state!.openNomination!.player!.yearsExp = 3
    await act(async () => { screen = create(tree()) })
    const row = screen.root.findByProps({ testID: 'player-meta-line' })
    const labels = row.findAllByType('Text' as React.ElementType).map(node => node.props.children)
    expect(labels.slice(-2)).toEqual(['25', 'Yr 4'])
})
