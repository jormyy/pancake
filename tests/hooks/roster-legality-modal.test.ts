import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useRosterLegality } from '@/hooks/use-roster-legality'
import { IRResolutionModal } from '@/components/IRResolutionModal'
import type { RosterLimits } from '@/lib/roster-capacity'
import { rosterPlayer } from '../helpers/fixtures'

const state = vi.hoisted(() => ({ roster: vi.fn(), drop: vi.fn(), move: vi.fn(), activate: vi.fn(), swap: vi.fn(), changed: vi.fn(), alert: vi.fn() }))
vi.mock('@/lib/roster', () => ({ getRoster: state.roster, dropPlayer: state.drop, toggleIR: state.move }))
vi.mock('@/lib/roster-add-flow', () => ({ resolveRosterAddIRConflict: state.activate, swapHealthyIrWithInjured: state.swap }))
vi.mock('@/lib/alert', () => ({ showAlert: state.alert }))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, View: 'View', Text: 'Text', StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/components/player/PlayerRowContent', () => ({ PlayerRowContent: 'PlayerRowContent' }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: ({ children, visible, ...props }: React.PropsWithChildren<{ visible: boolean }>) => visible ? React.createElement('Sheet', props, children) : null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
let latest: ReturnType<typeof useRosterLegality>

const healthy = rosterPlayer({ id: 'healthy', is_on_ir: true })
healthy.players = { ...healthy.players, display_name: 'Healthy', injury_status: null }
const eligible = rosterPlayer({ id: 'eligible', is_on_ir: true })
eligible.players = { ...eligible.players, display_name: 'Eligible', injury_status: 'Out' }

const Probe = ({ limits }: { limits: RosterLimits | null }) => {
    latest = useRosterLegality({ memberId: 'member', leagueId: 'league', limits, onChanged: state.changed })
    return React.createElement(IRResolutionModal, latest.modalProps)
}

const labels = () => screen.root.findAllByType('Button' as React.ElementType).map(node => node.props.accessibilityLabel)

beforeEach(async () => {
    vi.resetAllMocks()
    state.roster.mockResolvedValue([healthy])
    await act(async () => { screen = create(React.createElement(Probe, { limits: { rosterSize: 20, irSlots: 2, taxiSlots: 2 } })) })
})
afterEach(async () => { await act(async () => screen?.unmount()) })

it('keeps the capacity-independent Drop and hides capacity actions when limits disappear', async () => {
    await act(async () => { await latest.check() })
    expect(labels()).toEqual(expect.arrayContaining(['Activate Healthy', 'Drop Healthy']))
    await act(async () => screen.update(React.createElement(Probe, { limits: null })))
    expect(labels()).toContain('Drop Healthy')
    expect(labels()).not.toContain('Activate Healthy')
    expect(labels().some(label => label.startsWith('Swap '))).toBe(false)
    expect(labels().some(label => label.startsWith('Move '))).toBe(false)
})

it('drops once and closes the sheet when limits are unknown', async () => {
    await act(async () => { await latest.check() })
    await act(async () => screen.update(React.createElement(Probe, { limits: null })))
    state.roster.mockResolvedValue([])
    await act(async () => screen.root.findAllByProps({ accessibilityLabel: 'Drop Healthy' })[0].props.onPress())
    expect(state.drop).toHaveBeenCalledExactlyOnceWith('healthy')
    expect(latest.modalProps.visible).toBe(false)
    expect(state.changed).toHaveBeenCalledOnce()
})

it('does not list an eligible reserve row when limits are unknown', async () => {
    state.roster.mockResolvedValue([healthy, eligible])
    await act(async () => { await latest.check() })
    await act(async () => screen.update(React.createElement(Probe, { limits: null })))
    expect(labels()).toContain('Drop Healthy')
    expect(labels()).not.toContain('Drop Eligible')
})

it('alerts and closes when Activate is pressed after limits load from an unknown-limit sheet', async () => {
    await act(async () => screen.update(React.createElement(Probe, { limits: null })))
    await act(async () => { await latest.check() })
    expect(labels()).toContain('Drop Healthy')
    await act(async () => screen.update(React.createElement(Probe, { limits: { rosterSize: 20, irSlots: 2, taxiSlots: 2 } })))
    expect(labels()).toContain('Activate Healthy')
    await act(async () => screen.root.findAllByProps({ accessibilityLabel: 'Activate Healthy' })[0].props.onPress())
    expect(state.activate).not.toHaveBeenCalled()
    expect(state.alert).toHaveBeenCalledWith('Roster settings changed', expect.any(String))
    expect(latest.modalProps.visible).toBe(false)
})
