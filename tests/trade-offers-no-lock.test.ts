import './helpers/native-component-mocks'
import React from 'react'
import { Pressable } from 'react-native'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { TradeAssetColumn } from '@/components/trades/TradeAssetColumn'
import { readTradeAssetLocks } from '@/lib/trades'
import type { AssetLock } from '@/lib/locked-assets'
import { rosterPlayer } from './helpers/fixtures'

const state = vi.hoisted(() => ({ data: undefined as unknown }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member-a' }, currentLeague: { id: 'league' } }) }))
vi.mock('@/hooks/use-screen-view', () => ({ useScreenView: () => ({ data: state.data }) }))
vi.mock('@/components/player/PlayerRowContent', () => ({ PlayerRowContent: 'PlayerRowContent' }))
vi.mock('@/components/roster/LockedAssetNotice', async () => ({
    ...await vi.importActual('@/components/roster/LockedAssetNotice'), LockedAssetNotice: 'LockedAssetNotice',
}))

const player = rosterPlayer()
const pending: AssetLock = { assetKind: 'player', assetId: player.players.id, sourceKind: 'trade', sourceId: 'pending', reason: 'Locked by trade pending.' }
const pick = { kind: 'pick' as const, pickId: 'pick', seasonYear: 2028, round: 1, originalTeamName: 'Team A' }
const pickLock: AssetLock = { ...pending, assetKind: 'pick', assetId: pick.pickId }

it('uses the separate trading locks and tolerates snapshots without them', () => {
    expect(readTradeAssetLocks({ lockedAssets: [pending] })).toEqual([])
    expect(readTradeAssetLocks(null)).toEqual([])
    expect(readTradeAssetLocks({ tradeLockedAssets: [{ ...pending, sourceId: 'accepted' }, null] })).toEqual([{ ...pending, sourceId: 'accepted' }])
})

it.each(['pending', 'accepted', 'claim'])('selects assets according to %s locks', async source => {
    const locks = [pending, pickLock].map(lock => ({ ...lock, sourceId: source,
        sourceKind: source === 'claim' ? 'claim' as const : 'trade' as const }))
    state.data = { lockedAssets: locks, tradeLockedAssets: source === 'pending' ? [] : locks }
    const togglePlayer = vi.fn(), togglePick = vi.fn()
    let view!: ReturnType<typeof create>
    await act(async () => { view = create(React.createElement(TradeAssetColumn, {
        memberId: 'member-a', title: 'Team A', subtitle: 'Assets', side: 'give', twoColumn: false,
        roster: [player], picks: [pick], avgMap: new Map(), avgStatsMap: new Map(),
        selectedPlayerIds: new Set<string>(), selectedPickIds: new Set<string>(), onTogglePlayer: togglePlayer, onTogglePick: togglePick,
        emptyText: 'No players', testIdPrefix: 'assets',
    })) })
    const playerRow = view.root.find(node => node.type === Pressable && node.props.testID === `assets-player-${player.players.id}`)
    const pickRow = view.root.find(node => node.type === Pressable && node.props.testID === 'assets-pick-pick')
    expect(playerRow.props.disabled).toBe(source !== 'pending')
    expect(pickRow.props.disabled).toBe(source !== 'pending')
    if (source === 'pending') {
        await act(async () => { playerRow.props.onPress(); pickRow.props.onPress() })
        expect(togglePlayer).toHaveBeenCalledOnce()
        expect(togglePick).toHaveBeenCalledOnce()
        expect(view.root.findAllByType('LockedAssetNotice' as React.ElementType).every(node => node.props.locks.length === 0)).toBe(true)
    }
    expect(view.root.findAllByType('Text' as React.ElementType).map(node => String(node.props.children)).join(' ')).not.toContain('in other offers')
    await act(async () => view.unmount())
})
