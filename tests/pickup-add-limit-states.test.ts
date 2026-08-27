import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { PlayerSearchItem } from '@/components/PlayerSearchItem'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import type { PlayerRow } from '@/lib/players'

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    NativeModules: { BlobModule: null },
    StyleSheet: { create: (styles: unknown) => styles },
    Image: 'Image',
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}))
vi.mock('@/components/Motion', () => ({
    MotionPressable: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('Pressable', props, children),
    MotionView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('View', props, children),
}))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Badge', () => ({ Badge: 'Badge' }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))
vi.mock('@/lib/format', () => ({ countLabel: String, formatPoints: String, playerHeadshotUrl: () => null }))
vi.mock('@/lib/players', () => ({ getEligiblePositions: () => ['PG'] }))
vi.mock('@/lib/projections', () => ({ formatProjectionGame: () => null, numberOrDash: String }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REASON = "You've used all 7 of this week's adds. Adds reset Mon, Nov 2 at 12:00 AM ET."
const player = {
    id: 'player-a', display_name: 'Player A', nba_team: 'LAL', position: 'PG', eligible_positions: ['PG'],
    injury_status: null, nba_id: null, years_exp: 2, jersey_number: '1', dynasty_rank: null, headshot_url: null,
} as unknown as PlayerRow & { jersey_number: string; dynasty_rank: null; headshot_url: null }

describe('pickup entry points when the weekly add limit is reached', () => {
    it('search rows announce the block and still explain it on tap', async () => {
        const onAdd = vi.fn()
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(PlayerSearchItem, {
                item: player, currentMemberId: 'member', ownedMap: new Map(), waiverIds: new Set(), adding: null,
                gamesLeft: new Map(), animate: false, addBlockedReason: REASON, onAdd, onPress: vi.fn(),
            }))
        })
        const add = renderer.root.findByProps({ accessibilityLabel: 'Add Player A' })
        expect(add.props.accessibilityState).toEqual({ disabled: true })
        expect(add.props.accessibilityHint).toBe(REASON)
        expect(add.props.disabled).toBe(false)
        await act(async () => { add.props.onPress() })
        expect(onAdd).toHaveBeenCalledWith(player)
        await act(async () => { renderer.unmount() })
    })

    it('search rows are plain add buttons when adds are available', async () => {
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(PlayerSearchItem, {
                item: player, currentMemberId: 'member', ownedMap: new Map(), waiverIds: new Set(), adding: null,
                gamesLeft: new Map(), animate: false, onAdd: vi.fn(), onPress: vi.fn(),
            }))
        })
        const add = renderer.root.findByProps({ accessibilityLabel: 'Add Player A' })
        expect(add.props.accessibilityState).toEqual({ disabled: false })
        expect(add.props.accessibilityHint).toBeUndefined()
        await act(async () => { renderer.unmount() })
    })

    it('player header add and claim actions carry the reason and a caption', async () => {
        for (const status of ['free_agent', 'on_waivers'] as const) {
            const onAdd = vi.fn()
            const onClaim = vi.fn()
            let renderer!: ReactTestRenderer
            await act(async () => {
                renderer = create(React.createElement(PlayerHeader, {
                    player, rosterStatus: { status } as never, leagueActive: true, actionLoading: false,
                    addBlockedReason: REASON, addBlockedCaption: 'Adds 7/7 · resets Mon 12:00 AM ET',
                    onAdd, onDrop: vi.fn(), onClaim, onSetLineup: vi.fn(),
                }))
            })
            const label = status === 'free_agent' ? 'Add Player A' : 'Claim Player A'
            const action = renderer.root.findByProps({ accessibilityLabel: label })
            expect(action.props.accessibilityState).toEqual({ disabled: true })
            expect(action.props.accessibilityHint).toBe(REASON)
            expect(renderer.root.findAllByProps({ children: 'Adds 7/7 · resets Mon 12:00 AM ET' }).length).toBeGreaterThan(0)
            await act(async () => { action.props.onPress() })
            expect(status === 'free_agent' ? onAdd : onClaim).toHaveBeenCalled()
            await act(async () => { renderer.unmount() })
        }
    })
})
