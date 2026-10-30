import '../helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { PlayerRow } from '@/components/ui/PlayerRow'
import { Badge } from '@/components/ui/Badge'
import { LockedAssetNotice } from '@/components/roster/LockedAssetNotice'
import { RosterPlayerSheet } from '@/components/roster/RosterPlayerSheet'
import { RosterPickItem, RosterPlayerItem, TaxiPlayerItem } from '@/components/roster/RosterItems'
import { TradeAssetColumn } from '@/components/trades/TradeAssetColumn'
import { TradeRosterPlanEditor } from '@/components/trades/TradeRosterPlanEditor'
import { PicksBankList } from '@/components/league/LeaguePicksBank'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { showAlert } from '@/lib/alert'
import { rosterPlayer, headerPlayer } from '../helpers/fixtures'
import type { AssetLock } from '@/lib/locked-assets'

const data = vi.hoisted(() => ({ locks: [] as AssetLock[] }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'me' }, currentLeague: { id: 'league' } }) }))
vi.mock('@/hooks/use-screen-view', () => ({ useScreenView: () => ({ data: { lockedAssets: data.locks, tradeLockedAssets: data.locks } }) }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: 'Sheet' }))
vi.mock('@/components/ui/ScreenStatusOverlay', () => ({ ScreenStatusScrollView: 'ScrollView' }))
vi.mock('@/components/ui/SegmentedControl', () => ({ SegmentedControl: 'SegmentedControl' }))
vi.mock('@/components/ui/Page', () => ({ usePageMetrics: () => ({ padX: 16 }) }))
vi.mock('@/hooks/use-web-viewport', () => ({ useWebViewport: () => ({ viewportWidth: 390, viewportHeight: 844, compactLandscape: false }) }))

const trade: AssetLock = { assetKind: 'player', assetId: 'player-a', sourceKind: 'trade', sourceId: 'private-id', reason: 'Locked by trade private-id. Resolve the trade to change this asset.' }
const pickLock: AssetLock = { ...trade, assetKind: 'pick', assetId: 'pick' }
const locked = rosterPlayer({ assetLocks: [trade, { ...trade, sourceId: 'another-id' }] })
const pick = { kind: 'pick' as const, pickId: 'pick', seasonYear: 2028, round: 1, originalTeamName: 'Team', assetLocks: [pickLock] }
const noop = vi.fn()
let screen: ReactTestRenderer
const render = async (node: React.ReactElement) => { await act(async () => { screen = create(node) }) }
const check = (count = 1) => {
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Locked by a pending trade' })).toHaveLength(count)
    expect(JSON.stringify(screen.toJSON())).not.toContain('private-id')
    expect(screen.root.findAllByType('Text' as React.ElementType).some(node => node.props.children === 'Locked')).toBe(false)
}
afterEach(async () => { await act(async () => screen?.unmount()); vi.clearAllMocks(); data.locks = [] })

it('keeps one muted lock immediately after Yr even when the badge line wraps', async () => {
    await render(React.createElement(PlayerRow, { name: 'Player', yearsExp: 2, locks: locked.assetLocks }))
    const year = screen.root.findByType(Badge)
    const icon = screen.root.findByType(LockedAssetNotice)
    expect(year.props.label).toBe('Yr 3')
    expect(year.parent).toBe(icon.parent)
    expect(year.parent!.children).toEqual([year, icon])
    check()
})

it.each(['roster', 'taxi', 'roster pick', 'drop picker', 'review', 'player page', 'sheet'] as const)('renders one icon in the %s', async surface => {
    const nodes = {
        roster: React.createElement(RosterPlayerItem, { item: locked, slotType: 'BE', togglingId: null, taxiingId: null, droppingId: null, onPress: noop, onLongPress: noop, onToggleIR: noop }),
        taxi: React.createElement(TaxiPlayerItem, { item: locked, taxiingId: null, onPress: noop, onToggleTaxi: noop }),
        'roster pick': React.createElement(RosterPickItem, { pick, myTeamName: 'Team' }),
        'drop picker': React.createElement(DropPlayerPickerModal, { visible: true, title: 'Pick a drop', roster: [locked], dropping: null, onDrop: noop, onCancel: noop }),
        review: React.createElement(TradeRosterPlanEditor, { incoming: [], roster: [locked], value: { irPlayerIds: [], taxiPlayerIds: [], dropPlayerIds: [] }, onChange: noop, unavailableMoves: { 'player-a': trade.reason } }),
        'player page': React.createElement(PlayerHeader, { player: headerPlayer(), rosterStatus: { status: 'mine', rosterPlayerId: locked.id }, leagueActive: true, locks: locked.assetLocks, onDrop: noop }),
        sheet: React.createElement(RosterPlayerSheet, { player: locked, actions: [{ key: 'drop', label: 'Drop', icon: 'remove', onPress: noop }], onClose: noop }),
    }
    await render(nodes[surface])
    check()
})

it('preserves trade player and pick disabled states with independently pressable icons', async () => {
    data.locks = [trade, pickLock]
    await render(React.createElement(TradeAssetColumn, { memberId: 'me', title: 'You', subtitle: '', side: 'give', twoColumn: false, roster: [locked], picks: [pick], avgMap: new Map(), avgStatsMap: new Map(), selectedPlayerIds: new Set<string>(), selectedPickIds: new Set<string>(), onTogglePlayer: noop, onTogglePick: noop, emptyText: '' }))
    check(2)
    for (const row of screen.root.findAllByType('Pressable' as React.ElementType).filter(row => /for trade$/.test(row.props.accessibilityLabel))) expect(row.props.disabled).toBe(true)
    const icon = screen.root.findAllByProps({ accessibilityLabel: 'Locked by a pending trade' })[0]
    expect(icon.props.accessibilityState.disabled).toBe(false)
    for (let parent = icon.parent; parent; parent = parent.parent) {
        if (parent.type === 'Pressable' as React.ElementType) expect(parent.props.disabled).not.toBe(true)
    }
    await act(async () => await icon.props.onPress({ stopPropagation: noop }))
    expect(showAlert).toHaveBeenLastCalledWith('', 'Locked by a pending trade', 'info')
})

it('shows the league pick lock after its label', async () => {
    await render(React.createElement(PicksBankList, { picks: [{ id: 'pick', seasonYear: 2028, round: 1, isUsed: false, originalOwnerMemberId: 'me', currentOwnerMemberId: 'me', originalTeamName: 'Team', currentTeamName: 'Team' }], myMemberId: 'me', locks: [pickLock] }))
    check()
    const icon = screen.root.findByType(LockedAssetNotice)
    expect((icon.parent!.children[0] as import('react-test-renderer').ReactTestInstance).props.children).toBe('2028 R1')
})

it('explains a disabled drop without invoking the destructive action', async () => {
    await render(React.createElement(RosterPlayerSheet, { player: locked, actions: [{ key: 'drop', label: 'Drop', icon: 'remove', onPress: noop }], onClose: noop }))
    expect(screen.root.findByProps({ accessibilityLabel: 'Drop' }).props.disabled).toBe(true)
    await act(async () => await screen.root.findByProps({ accessibilityLabel: 'Explain unavailable Drop' }).props.onPress())
    expect(noop).not.toHaveBeenCalled()
    expect(showAlert).toHaveBeenLastCalledWith('', 'Locked by a pending trade', 'info')
})

vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))

vi.mock('@/lib/alert', () => ({ showAlert: vi.fn() }))
