import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PendingTradeRosterPlan } from '@/components/trades/PendingTradeRosterPlan'
import { trade } from '../../helpers/fixtures'
import type { TradeRosterPreview } from '@/lib/trades'

const reads = vi.hoisted(() => ({ roster: vi.fn(), preview: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/roster', () => ({ getRoster: reads.roster }))
vi.mock('@/lib/trade-legality', () => ({ previewTradeLegality: reads.preview }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ currentLeague: { id: 'league', ir_slots: 2, taxi_slots: 3 } }) }))
vi.mock('react-native', () => ({ Text: 'Text', View: 'View', Modal: 'Modal', ScrollView: 'ScrollView', Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value } }))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('@/components/ui', () => ({ Button: 'Button', ErrorBanner: 'ErrorBanner', PageHeader: 'PageHeader' }))
vi.mock('@/components/trades/TradeRosterPlanEditor', () => ({ TradeRosterPlanEditor: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const teams: TradeRosterPreview[] = [{ memberId: 'member', teamName: 'Matthew', limits: { active: 20, ir: 2, taxi: 3 }, roster: [], drops: [], moves: [], error: null }]
const text = () => screen.root.findAllByType('Text' as React.ElementType).map(node => React.Children.toArray(node.props.children).join(''))
const confirmDisabled = () => screen.root.findAllByType('Button' as React.ElementType).find(node => node.props.title === 'Confirm')?.props.disabled
const render = (value = trade()) => React.createElement(PendingTradeRosterPlan, { trade: value, memberId: 'member', onCancel: vi.fn(), onConfirmed: vi.fn() })
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(150) }) }
beforeEach(() => { vi.useFakeTimers(); reads.roster.mockReset().mockResolvedValue([]); reads.preview.mockReset().mockResolvedValue(teams) })
afterEach(async () => { await act(async () => screen?.unmount()); vi.useRealTimers() })

it('retains the last roster summary during replacement reads and a failed refresh', async () => {
    const offer = trade()
    await act(async () => { screen = create(render(offer)) })
    await settle()
    const settled = text()
    expect(settled).toContain('Matthew: 0/20 · IR 0/2 · Taxi 0/3')
    let resolve!: (value: TradeRosterPreview[]) => void
    reads.preview.mockReturnValueOnce(new Promise<TradeRosterPreview[]>(done => { resolve = done }))
    await act(async () => screen.update(render({ ...offer, version: 2 })))
    await settle()
    expect(text()).toEqual(expect.arrayContaining(settled.filter(line => line.includes('Matthew'))))
    expect(confirmDisabled()).toBe(true)
    await act(async () => resolve(teams))
    expect(confirmDisabled()).toBe(false)
    reads.preview.mockRejectedValueOnce(new Error('temporarily unavailable'))
    await act(async () => screen.update(render({ ...offer, version: 3 })))
    await settle()
    expect(text()).toContain('Matthew: 0/20 · IR 0/2 · Taxi 0/3')
    expect(confirmDisabled()).toBe(true)
})

it('keeps a legal plan valid while refreshing the same terms', async () => {
    const offer = trade()
    await act(async () => { screen = create(render(offer)) })
    await settle()
    expect(confirmDisabled()).toBe(false)
    reads.preview.mockReturnValueOnce(new Promise(() => {}))
    await act(async () => screen.update(render({ ...offer, notes: 'Background update' })))
    await settle()
    expect(confirmDisabled()).toBe(false)
    expect(text()).toContain('Matthew: 0/20 · IR 0/2 · Taxi 0/3')
})

it('blocks changed terms and rejects a previous offer response', async () => {
    const offer = trade()
    let resolve!: (value: TradeRosterPreview[]) => void
    reads.preview.mockReturnValueOnce(new Promise<TradeRosterPreview[]>(done => { resolve = done })).mockResolvedValueOnce(teams)
    await act(async () => { screen = create(render(offer)) })
    await settle()
    await act(async () => screen.update(render({ ...offer, id: 'next' })))
    await settle()
    const settled = text()
    await act(async () => resolve([]))
    expect(text()).toEqual(settled)
    expect(confirmDisabled()).toBe(false)
    reads.preview.mockReturnValueOnce(new Promise(() => {}))
    await act(async () => screen.update(render({ ...offer, id: 'next', version: 2 })))
    await settle()
    expect(text()).toContain('Matthew: 0/20 · IR 0/2 · Taxi 0/3')
    expect(confirmDisabled()).toBe(true)
})
