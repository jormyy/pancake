import './helpers/native-component-mocks'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { TradeLegalityScreen } from '@/components/trades/TradeLegalityScreen'
import { trade } from './helpers/fixtures'
import type { TradeRosterPreview } from '@/lib/trades'

vi.mock('@/components/ui', () => ({ ErrorBanner: 'ErrorBanner', PageHeader: 'PageHeader' }))
vi.mock('@/components/trades/TradeCard', () => ({ TradeCard: 'TradeCard' }))
vi.mock('@/components/trades/TradeRosterPlanEditor', () => ({ TradeRosterPlanEditor: 'TradeRosterPlanEditor' }))

it.each(['propose', 'accept'] as const)('shows only the viewer status in %s', async mode => {
    const own: TradeRosterPreview = { memberId: 'member-a', teamName: 'My team', limits: { active: 1, ir: 0, taxi: 0 },
        roster: ['a', 'b'].map(playerId => ({ playerId, name: playerId, location: 'active' })), drops: [], moves: [], legal: false, error: 'Full',
        reasons: [{ memberId: 'member-a', teamName: 'My team', rule: 'active_slots', message: 'Full', suggestedMoves: [] }] }
    const other = { ...own, memberId: 'member-b', teamName: 'Other team' }
    const props = { trade: trade(), memberId: 'member-a', teams: [own, other], mode, loading: false, saving: false,
        error: null, onRetry: vi.fn(), onClose: vi.fn(), onSubmit: vi.fn(), editor: { incoming: [], roster: [],
            value: { taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: [] }, onChange: vi.fn() } }
    let view!: ReturnType<typeof create>
    await act(async () => { view = create(React.createElement(TradeLegalityScreen, props)) })
    const status = () => view.root.findByProps({ testID: 'trade-roster-status' }).findAllByType('Text' as React.ElementType)
        .map(node => React.Children.toArray(node.props.children).join(''))
    expect(status()).toEqual(['Invalid roster', '• 1 over roster limit (2/1)'])
    await act(async () => view.update(React.createElement(TradeLegalityScreen, { ...props, teams: [{ ...own, legal: true, error: null }, other] })))
    expect(status()).toEqual(['Valid roster'])
    await act(async () => view.unmount())
})
