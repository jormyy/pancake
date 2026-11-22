import '../helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { IRResolutionModal } from '@/components/IRResolutionModal'
import { rosterPlayer } from '../helpers/fixtures'

vi.mock('@/components/ui/Sheet', () => ({ Sheet: ({ children, visible, ...props }: React.PropsWithChildren<{ visible: boolean }>) => visible ? React.createElement('Sheet', props, children) : null }))

let screen: ReactTestRenderer
afterEach(async () => { await act(async () => screen?.unmount()) })

const healthyIr = rosterPlayer({ id: 'ir', is_on_ir: true })
healthyIr.players = { ...healthyIr.players, display_name: 'Healthy Vet', injury_status: null }
const injured = rosterPlayer({ id: 'injured' })
injured.players = { ...injured.players, display_name: 'Injured Star', injury_status: 'Out' }
const taxi = rosterPlayer({ id: 'taxi', is_on_taxi: true })
taxi.players = { ...taxi.players, display_name: 'Taxi Guy', injury_status: 'Out' }

const props = (overrides: Record<string, unknown> = {}) => ({
    visible: true, ineligibleIR: [healthyIr], activeRoster: [injured], rosterSize: 1, pendingPlayerName: '',
    onActivate: vi.fn(), onDropAndActivate: vi.fn(), onSwapWithInjured: vi.fn(), onDrop: vi.fn(), onCancel: vi.fn(),
    ...overrides,
})

const swapLabels = () => screen.root.findAll((node) => typeof node.props.accessibilityLabel === 'string' &&
    node.props.accessibilityLabel.startsWith('Swap '))

it('offers a swap with an injured active player when the bench is full', async () => {
    const swap = vi.fn()
    await act(async () => { screen = create(React.createElement(IRResolutionModal, props({ onSwapWithInjured: swap }))) })
    expect(swapLabels().length).toBeGreaterThan(0)
    await act(async () => screen.root.findAllByProps({ accessibilityLabel: 'Swap Healthy Vet with Injured Star' })[0].props.onPress())
    expect(swap).toHaveBeenCalledExactlyOnceWith(healthyIr, injured)
})

it('keeps the existing Drop option beside the swap', async () => {
    await act(async () => { screen = create(React.createElement(IRResolutionModal, props())) })
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Drop Healthy Vet' }).length).toBeGreaterThan(0)
})

it('hides the swap when the active roster has room', async () => {
    await act(async () => { screen = create(React.createElement(IRResolutionModal, props({ rosterSize: 2 }))) })
    expect(swapLabels()).toHaveLength(0)
})

it('hides the swap when no injured active player is available', async () => {
    const healthy = rosterPlayer({ id: 'healthy' })
    healthy.players = { ...healthy.players, display_name: 'Healthy Guard', injury_status: null }
    await act(async () => { screen = create(React.createElement(IRResolutionModal, props({ activeRoster: [healthy] }))) })
    expect(swapLabels()).toHaveLength(0)
})

it('hides the swap when the injured player is reserved', async () => {
    const reserved = { ...injured, assetLocks: [{ assetKind: 'player' as const, assetId: 'injured', sourceKind: 'trade' as const,
        sourceId: 'trade-1', reason: 'Locked by trade.' }] }
    await act(async () => { screen = create(React.createElement(IRResolutionModal, props({ activeRoster: [reserved] }))) })
    expect(swapLabels()).toHaveLength(0)
})

it('never offers a taxi swap', async () => {
    await act(async () => { screen = create(React.createElement(IRResolutionModal, props({ ineligibleIR: [taxi] }))) })
    expect(swapLabels()).toHaveLength(0)
})

it('does not activate or swap while the roster limit is unknown but still allows a drop', async () => {
    const activate = vi.fn(), swap = vi.fn(), drop = vi.fn()
    await act(async () => { screen = create(React.createElement(IRResolutionModal, props({ rosterSize: undefined, onActivate: activate, onSwapWithInjured: swap, onDrop: drop }))) })
    await act(async () => screen.root.findAllByProps({ accessibilityLabel: 'Activate Healthy Vet' })[0].props.onPress())
    expect(activate).not.toHaveBeenCalled()
    expect(swapLabels()).toHaveLength(0)
    await act(async () => screen.root.findAllByProps({ accessibilityLabel: 'Drop Healthy Vet' })[0].props.onPress())
    expect(drop).toHaveBeenCalledWith(healthyIr)
})
