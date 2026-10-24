import './helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlayerSearchItem } from '@/components/PlayerSearchItem'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { claimProcessWeekdayLabel } from '@/lib/waivers'
import { colors, uiColors } from '@/constants/tokens'
import { headerPlayer, playerRow, rosterStatus } from './helpers/fixtures'

vi.mock('@/lib/format', () => ({ countLabel: String, formatPoints: String, playerHeadshotUrl: () => null }))
vi.mock('@/lib/players', () => ({ getEligiblePositions: () => ['PG'] }))
vi.mock('@/lib/projections', () => ({ formatProjectionGame: () => null, numberOrDash: String }))

const REASON = 'Weekly add limit reached (7/7 adds used this week). Adds reset Mon, Nov 2 at 12:00 AM ET.'
const CAPTION = 'Adds 7/7 · resets Mon, Nov 2 at 12:00 AM ET'
let renderer: ReactTestRenderer | null = null

afterEach(async () => {
    if (renderer) await act(async () => { renderer?.unmount() })
    renderer = null
})

async function renderSearchItem(props: Partial<React.ComponentProps<typeof PlayerSearchItem>> = {}) {
    await act(async () => {
        renderer = create(React.createElement(PlayerSearchItem, {
            item: playerRow(), currentMemberId: 'member', ownedMap: new Map(), waiverIds: new Set<string>(), isAdding: false,
            animate: false, onAdd: vi.fn(), onPress: vi.fn(), ...props,
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

    it('shows the scheduled waiver day and keeps the claim action distinct from an add', async () => {
        const clearsAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
        const tree = await renderSearchItem({ waiverIds: new Set(['player-a']), waiverClearsAt: clearsAt })
        const claim = tree.root.findByProps({ accessibilityLabel: 'Claim Player A' })
        expect(claim.props.disabled).toBe(false)
        expect(tree.root.findAll((node) => String(node.type) === 'Text').map((node) => node.props.children)).toContain(`W · ${claimProcessWeekdayLabel(clearsAt)}`)
        const button = claim.find((node) => String(node.type) === 'View')
        expect(button.props.style).toContainEqual({ backgroundColor: colors.infoLight, borderColor: colors.info, borderWidth: 1 })
    })

    it('opens the claim list for an already pending claim', async () => {
        const onAdd = vi.fn()
        const tree = await renderSearchItem({ waiverIds: new Set(['player-a']), claimPending: true, onAdd })
        const pending = tree.root.findByProps({ accessibilityLabel: 'Claim pending for Player A, view claims' })
        expect(pending.findByProps({ name: 'schedule' }).props).toMatchObject({ name: 'schedule', color: uiColors.waiverText })
        await act(async () => { pending.props.onPress() })
        expect(onAdd).toHaveBeenCalledWith(playerRow())
    })

    it('search rows disable pickup while the screen is offline', async () => {
        const tree = await renderSearchItem({ addDisabled: true })
        const add = tree.root.findByProps({ accessibilityLabel: 'Add Player A' })
        expect(add.props.disabled).toBe(true)
        expect(add.props.accessibilityState).toEqual({ disabled: true })
    })

    it('search rows are plain add buttons when adds are available', async () => {
        const tree = await renderSearchItem()
        const add = tree.root.findByProps({ accessibilityLabel: 'Add Player A' })
        expect(add.props.accessibilityState).toEqual({ disabled: false })
        expect(add.props.accessibilityHint).toBeUndefined()
    })

    async function renderHeader(status: ReturnType<typeof rosterStatus.freeAgent>, handlers: { onAdd: () => void; onClaim: () => void }) {
        await act(async () => {
            renderer = create(React.createElement(PlayerHeader, {
                player: headerPlayer(), rosterStatus: status, leagueActive: true, actionLoading: false,
                addBlockedReason: REASON, addBlockedCaption: CAPTION,
                onDrop: vi.fn(), onSetLineup: vi.fn(), ...handlers,
            }))
        })
        return renderer!
    }

    it('player header add action carries the reason and a caption', async () => {
        const onAdd = vi.fn()
        const tree = await renderHeader(rosterStatus.freeAgent(), { onAdd, onClaim: vi.fn() })
        const action = tree.root.findByProps({ accessibilityLabel: 'Add Player A' })
        expect(action.props.accessibilityState).toEqual({ disabled: true })
        expect(action.props.accessibilityHint).toBe(REASON)
        expect(tree.root.findAllByProps({ children: CAPTION }).length).toBeGreaterThan(0)
        await act(async () => { action.props.onPress() })
        expect(onAdd).toHaveBeenCalled()
    })

    it('player header claim action stays plain; the claim modal owns that gate', async () => {
        const onClaim = vi.fn()
        const tree = await renderHeader(rosterStatus.onWaivers(), { onAdd: vi.fn(), onClaim })
        const action = tree.root.findByProps({ accessibilityLabel: 'Claim Player A' })
        expect(action.props.accessibilityState).toEqual({ disabled: false })
        expect(action.props.accessibilityHint).toBeUndefined()
        expect(tree.root.findAllByProps({ children: CAPTION })).toHaveLength(0)
        await act(async () => { action.props.onPress() })
        expect(onClaim).toHaveBeenCalled()
    })
    it('shows a pending claim in the player header and opens the claims list', async () => {
        const onClaim = vi.fn()
        await act(async () => {
            renderer = create(React.createElement(PlayerHeader, {
                player: headerPlayer(), rosterStatus: rosterStatus.onWaivers(), leagueActive: true, actionLoading: false,
                claimPending: true, onAdd: vi.fn(), onDrop: vi.fn(), onClaim, onSetLineup: vi.fn(),
            }))
        })
        const pending = renderer!.root.findByProps({ accessibilityLabel: 'Claim pending for Player A, view claims' })
        expect(pending.findByProps({ children: 'Claim pending' }).props.children).toBe('Claim pending')
        await act(async () => { pending.props.onPress() })
        expect(onClaim).toHaveBeenCalledOnce()
    })

})

it('labels an IR add and keeps its label during a pending write', async () => {
    const props = { item: playerRow(), currentMemberId: 'member', ownedMap: new Map(), waiverIds: new Set<string>(), isAdding: false, addToIR: true, animate: false, onAdd: vi.fn(), onPress: vi.fn() }
    const tree = await renderSearchItem(props)
    const button = tree.root.findByProps({ accessibilityLabel: 'Add to IR Player A' })
    expect(button.findByProps({ children: 'Add to IR' })).toBeDefined()
    await act(async () => tree.update(React.createElement(PlayerSearchItem, { ...props, isAdding: true })))
    expect(tree.root.findByProps({ accessibilityLabel: 'Add to IR Player A' }).props.disabled).toBe(true)
    expect(tree.root.findByProps({ children: 'Add to IR' })).toBeDefined()
})
