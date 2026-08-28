import './helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlayerSearchItem } from '@/components/PlayerSearchItem'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { headerPlayer, playerRow, rosterStatus } from './helpers/fixtures'

vi.mock('@/lib/format', () => ({ countLabel: String, formatPoints: String, playerHeadshotUrl: () => null }))
vi.mock('@/lib/players', () => ({ getEligiblePositions: () => ['PG'] }))
vi.mock('@/lib/projections', () => ({ formatProjectionGame: () => null, numberOrDash: String }))

const REASON = "You've used all 7 of this week's adds. Adds reset Mon, Nov 2 at 12:00 AM ET."
const CAPTION = 'Adds 7/7 · resets Mon 12:00 AM ET'
let renderer: ReactTestRenderer | null = null

afterEach(async () => {
    if (renderer) await act(async () => { renderer?.unmount() })
    renderer = null
})

async function renderSearchItem(props: Partial<React.ComponentProps<typeof PlayerSearchItem>> = {}) {
    await act(async () => {
        renderer = create(React.createElement(PlayerSearchItem, {
            item: playerRow(), currentMemberId: 'member', ownedMap: new Map(), waiverIds: new Set<string>(), adding: null,
            gamesLeft: new Map(), animate: false, onAdd: vi.fn(), onPress: vi.fn(), ...props,
        }))
    })
    return renderer!
}

describe('pickup entry points when the weekly add limit is reached', () => {
    it('search rows announce the block and still explain it on tap', async () => {
        const onAdd = vi.fn()
        const tree = await renderSearchItem({ addBlockedReason: REASON, onAdd })
        const add = tree.root.findByProps({ accessibilityLabel: 'Add Player A' })
        expect(add.props.accessibilityState).toEqual({ disabled: true })
        expect(add.props.accessibilityHint).toBe(REASON)
        expect(add.props.disabled).toBe(false)
        await act(async () => { add.props.onPress() })
        expect(onAdd).toHaveBeenCalledWith(playerRow())
    })

    it('search rows are plain add buttons when adds are available', async () => {
        const tree = await renderSearchItem()
        const add = tree.root.findByProps({ accessibilityLabel: 'Add Player A' })
        expect(add.props.accessibilityState).toEqual({ disabled: false })
        expect(add.props.accessibilityHint).toBeUndefined()
    })

    it.each([
        ['free_agent', rosterStatus.freeAgent(), 'Add Player A', 'onAdd'],
        ['on_waivers', rosterStatus.onWaivers(), 'Claim Player A', 'onClaim'],
    ] as const)('player header %s action carries the reason and a caption', async (_name, status, label, handlerName) => {
        const handlers = { onAdd: vi.fn(), onClaim: vi.fn() }
        await act(async () => {
            renderer = create(React.createElement(PlayerHeader, {
                player: headerPlayer(), rosterStatus: status, leagueActive: true, actionLoading: false,
                addBlockedReason: REASON, addBlockedCaption: CAPTION,
                onDrop: vi.fn(), onSetLineup: vi.fn(), ...handlers,
            }))
        })
        const action = renderer!.root.findByProps({ accessibilityLabel: label })
        expect(action.props.accessibilityState).toEqual({ disabled: true })
        expect(action.props.accessibilityHint).toBe(REASON)
        expect(renderer!.root.findAllByProps({ children: CAPTION }).length).toBeGreaterThan(0)
        await act(async () => { action.props.onPress() })
        expect(handlers[handlerName]).toHaveBeenCalled()
    })
})
