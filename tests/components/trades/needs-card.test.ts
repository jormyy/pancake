import '../../helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { TradeNeedsCard } from '@/components/trades/TradeNeedsCard'

vi.mock('@/components/ui', () => ({ Button: 'Button' }))

let screen: ReactTestRenderer | null = null

afterEach(async () => {
    if (screen) await act(async () => { screen?.unmount() })
    screen = null
})

const texts = () => screen!.root.findAllByType('Text' as React.ElementType)
    .map(node => React.Children.toArray(node.props.children).join(''))
const button = () => screen!.root.findAllByType('Button' as React.ElementType)[0]

async function renderCard(overrides: Partial<React.ComponentProps<typeof TradeNeedsCard>> = {}) {
    await act(async () => {
        screen = create(React.createElement(TradeNeedsCard, {
            incoming: 0, awaitingVote: 0, outgoing: 0, proposeDisabled: false, onPropose: vi.fn(),
            ...overrides,
        }))
    })
}

it('counts every trade that needs the manager now', async () => {
    await renderCard({ incoming: 2, awaitingVote: 1 })
    expect(texts()).toContain('3')
    expect(texts()).toContain('offers to answer')
    expect(texts()).toContain('trade awaiting your vote')
    expect(texts()).not.toContain('pending offers')
    expect(screen!.root.findAllByProps({ accessibilityLabel: '2 offers to answer' })).toHaveLength(1)
})

it('offers one large propose action when nothing needs the manager', async () => {
    const onPropose = vi.fn()
    await renderCard({ onPropose })
    expect(texts()).toContain('All caught up')
    expect(texts()).toContain('All clear')
    const actions = screen!.root.findAllByType('Button' as React.ElementType)
    expect(actions).toHaveLength(1)
    expect(button().props.title).toBe('Propose trade')
    expect(button().props.size).toBe('lg')
    expect(button().props.fullWidth).toBe(true)
    expect(button().props.disabled).toBe(false)
    await act(async () => { button().props.onPress() })
    expect(onPropose).toHaveBeenCalledTimes(1)
})

it('disables the propose action when trading is closed', async () => {
    await renderCard({ proposeDisabled: true })
    expect(button().props.disabled).toBe(true)
})

