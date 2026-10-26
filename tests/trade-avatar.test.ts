import './helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssetList } from '@/components/trades/TradeCard'
import { TradeBlockListingRow, TradeBlockPlayerRow } from '@/components/trades/TradeListRow'
import type { TradeItem } from '@/lib/trades'
import { rosterPlayer } from './helpers/fixtures'

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/SectionHeader', () => ({ SectionHeader: 'SectionHeader' }))
vi.mock('@/components/trades/MultiTeamTradeOverview', () => ({ MultiTeamTradeOverview: () => null }))
vi.mock('@/lib/format', () => ({ playerHeadshotUrl: () => '/player-headshot', yearShort: String }))
vi.mock('@/lib/player-context', () => ({ playerEligiblePositions: () => [], playerSeasonContextText: () => '' }))

const asset: Extract<TradeItem, { kind: 'player' }> = { kind: 'player', playerId: 'player-a', playerName: 'Player A', nbaId: '123', position: 'PG', nbaTeam: 'BOS' }
let renderer: ReactTestRenderer | null = null

afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount())
    renderer = null
})

async function expectPlayerAvatar(element: React.ReactElement) {
    await act(async () => { renderer = create(element) })
    const avatar = renderer!.root.findByType('Avatar' as React.ElementType)
    expect(avatar.props.name).toBe('Player A')
    expect(avatar.props.uri).toBe('/player-headshot')
}

describe('trade player identity', () => {
    it('keeps card and detail identities on the shared avatar contract', async () => {
        await expectPlayerAvatar(React.createElement(AssetList, { items: [asset], label: 'You receive' }))
    })

    it('keeps league block identities on the shared avatar contract', async () => {
        await expectPlayerAvatar(React.createElement(TradeBlockListingRow, {
            item: { _type: 'blockItem', item: { id: 'listing', memberId: 'other', teamName: 'Other', asset, note: null, updatedAt: '2026-10-24T12:00:00Z' } },
            myMemberId: 'mine', blockBusyId: null, onRemove: vi.fn(), onSaveNote: vi.fn(),
        }))
    })

    it('keeps owned block identities on the shared avatar contract', async () => {
        const player = rosterPlayer()
        await expectPlayerAvatar(React.createElement(TradeBlockPlayerRow, {
            item: { _type: 'blockPlayer', player: { ...player, players: { ...player.players, nba_id: '123' } } },
            listed: false, busy: false, blockAvgMap: new Map(), blockAvgStatsMap: new Map(), onList: vi.fn(),
        }))
    })
})
