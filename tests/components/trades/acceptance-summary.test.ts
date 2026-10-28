import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { FeedbackProvider, feedbackBridge } from '@/components/ui/feedback'
import { tradeAcceptanceSummary } from '@/components/trades/acceptance-summary'
import { trade } from '../../helpers/fixtures'
import type { TradeRosterPreview } from '@/lib/trades'

vi.mock('react-native', () => ({ Animated: { View: 'View' }, Modal: 'Modal', Pressable: 'Pressable', Text: 'Text', View: 'View', Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value }, useWindowDimensions: () => ({ width: 390 }) }))
vi.mock('@/components/Motion', () => ({ useReducedMotion: () => true }))
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it.each([0, 1, 2])('renders compact acceptance text with %s required drops', async count => {
    const team: TradeRosterPreview = { memberId: 'me', teamName: 'Matthew', limits: { active: 20, ir: 2, taxi: 3 }, roster: ['active', 'ir', 'taxi'].flatMap((location, index) => Array.from({ length: [20, 2, 3][index] }, (_, n) => ({ playerId: `${location}-${n}`, name: 'Unrelated Roster Name', location: location as 'active' | 'ir' | 'taxi' }))), drops: Array.from({ length: count }, (_, n) => ({ playerId: String(n), name: `Drop ${n}` })), moves: [], error: null }
    const offer = trade({ routedItems: [{ kind: 'player', playerId: 'in', playerName: 'Incoming Player', position: 'PG', nbaTeam: 'BOS', fromMemberId: 'other', toMemberId: 'me' }, { kind: 'faab', amount: 5, fromMemberId: 'me', toMemberId: 'other' }] })
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(FeedbackProvider, null, null)) })
    await act(async () => { void feedbackBridge.api!.confirm({ title: 'Accept trade?', message: tradeAcceptanceSummary(offer, [team], 'me') }) })
    const text = screen.root.findAllByType('Text' as React.ElementType).map(node => React.Children.toArray(node.props.children).join('')).join('\n')
    expect(text).toContain('You give: $5 FAAB\nYou get: Incoming Player\nMatthew: 20/20 · IR 2/2 · Taxi 3/3')
    expect(text).toContain('Completes after review.')
    expect(text).not.toContain('Unrelated Roster Name')
    if (count) expect(text).toContain(`Drops: ${team.drops.map(player => player.name).join(', ')}`)
    else expect(text).not.toContain('must drop')
    await act(async () => screen.unmount())
})
