import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { AuctionIdlePanel } from '@/components/league/draft-room/AuctionIdlePanel'
import { PageHeader } from '@/components/ui/Page'
import { SettingsRow } from '@/components/settings/SettingsGroup'

vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', Image: 'Image', TextInput: 'TextInput', Pressable: 'Pressable',
    Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('@shopify/flash-list', () => ({ FlashList: 'FlashList' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))
vi.mock('@/components/Motion', () => ({ MotionPressable: 'MotionPressable' }))
vi.mock('@/lib/format', () => ({ playerHeadshotUrl: () => null }))
vi.mock('@/lib/players', () => ({ getEligiblePositions: () => ['PG'] }))
vi.mock('@/lib/draft', () => ({ NOMINATION_ORDER_MODE_LABELS: { snake: 'Snake' } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const flatten = (style: unknown): Record<string, unknown> => Object.assign({}, ...[style].flat(Infinity).filter(Boolean))
afterEach(async () => { await act(async () => screen?.unmount()) })

it('reserves one player action row before roster status arrives and keeps disabled actions mounted', async () => {
    const props = {
        player: { display_name: 'Player', nba_team: 'BOS', position: 'PG', eligible_positions: ['PG'],
            jersey_number: null, injury_status: null, dynasty_rank: 1, headshot_url: null, nba_id: null, years_exp: 1 },
        rosterStatus: null, leagueActive: true, actionsReady: false,
        onDrop: vi.fn(), compact: true,
    }
    await act(async () => { screen = create(React.createElement(PlayerHeader, props)) })
    const actionColumn = () => screen.root.findAllByType('View' as React.ElementType)
        .find(node => node.props['aria-busy'] === true)
    expect(actionColumn()).toBeDefined()
    const reserved = flatten(actionColumn()?.props.style)
    expect(reserved.minWidth).toBeGreaterThanOrEqual(76)
    expect(reserved.minHeight).toBe(44)
    await act(async () => screen.update(React.createElement(PlayerHeader, { ...props, rosterStatus: { status: 'mine' as const, rosterPlayerId: 'roster' },
        action: { label: 'Set lineup', onPress: vi.fn(), disabled: true, busy: false } })))
    expect(flatten(actionColumn()?.props.style)).toEqual(reserved)
    expect(screen.root.findAllByType('Pressable' as React.ElementType)).toHaveLength(2)
    expect(screen.root.findAllByType('Pressable' as React.ElementType).every(node => node.props.disabled)).toBe(true)
})

it('keeps nomination controls and the same hint height while the live connection recovers', async () => {
    const controller = {
        state: { draft: { status: 'active', nominationOrderMode: 'snake' }, order: [], currentNominatorMemberId: 'me' },
        realtimeConnected: true, actionsReady: true, nominating: false, setNominating: vi.fn(),
    } as unknown as React.ComponentProps<typeof AuctionIdlePanel>['controller']
    await act(async () => { screen = create(React.createElement(AuctionIdlePanel, { controller, memberId: 'me', compact: false })) })
    const before = screen.root.findAllByType('Text' as React.ElementType).map(node => flatten(node.props.style))
    expect(before.some(style => style.textAlign === 'left' && Number(style.height) > 0)).toBe(true)
    await act(async () => screen.update(React.createElement(AuctionIdlePanel, {
        controller: { ...controller, realtimeConnected: false, actionsReady: false }, memberId: 'me', compact: false,
    })))
    const nominate = screen.root.findByType('MotionPressable' as React.ElementType)
    expect(nominate.props.accessibilityLabel).toBe('Search and nominate a player')
    expect(nominate.props.disabled).toBe(true)
    expect(screen.root.findAllByType('Text' as React.ElementType).map(node => flatten(node.props.style))).toEqual(before)
    const status = screen.root.findAllByType('Text' as React.ElementType).find(node => node.props.children === 'Reconnecting live draft. Nominations stay disabled.')
    expect(status).toBeDefined()
    expect(flatten(status?.props.style).textAlign).toBe('left')
})

it('reserves the roster metadata line before its value arrives', async () => {
    await act(async () => { screen = create(React.createElement(PageHeader, { title: 'Team roster', reserveMeta: true })) })
    const before = screen.root.findAllByType('Text' as React.ElementType)
    expect(before).toHaveLength(2)
    const metaStyle = flatten(before[1].props.style)
    expect(metaStyle.minHeight).toBeGreaterThan(0)
    await act(async () => screen.update(React.createElement(PageHeader, { title: 'Team roster', reserveMeta: true, meta: '12 active' })))
    expect(flatten(screen.root.findAllByType('Text' as React.ElementType)[1].props.style)).toEqual(metaStyle)
})

it('keeps the account value column width when its text arrives', async () => {
    await act(async () => { screen = create(React.createElement(SettingsRow, { label: 'Name', value: '', reserveValue: true })) })
    const value = () => screen.root.findAllByType('Text' as React.ElementType)[1]
    const before = flatten(value().props.style)
    expect(before.width).toBe('60%')
    await act(async () => screen.update(React.createElement(SettingsRow, { label: 'Name', value: 'A complete manager name', reserveValue: true })))
    expect(flatten(value().props.style)).toEqual(before)
})


it('keeps the existing flexible settings layout unless a value column is reserved', async () => {
    await act(async () => { screen = create(React.createElement(SettingsRow, { label: 'Trade veto window', value: '24 hours' })) })
    const value = screen.root.findAllByType('Text' as React.ElementType)[1]
    expect(flatten(value.props.style).width).toBeUndefined()
    expect(flatten(value.props.style).maxWidth).toBe('60%')
})
