import './helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { RosterClaimItem } from '@/components/roster/RosterItems'
import { claimProcessTimeLabel, type WaiverClaim } from '@/lib/waivers'

const claim: WaiverClaim = {
    id: 'claim', playerId: 'player', playerName: 'Player A', playerNbaId: null,
    dropPlayerId: null, dropPlayerName: null, dropPlayerNbaId: null, status: 'pending',
    submittedAt: '2026-10-08T00:00:00Z', processDate: '2026-10-10', priorityAtSubmission: 3,
    bidAmount: 10, claimOrder: 1, failureReason: null, clearsAt: '2026-10-10T12:00:00Z',
}
let renderer: ReactTestRenderer | undefined
afterEach(async () => { if (renderer) await act(async () => { renderer?.unmount() }); vi.useRealTimers() })

it('shows the scheduled run without repeated priority or order and preserves claim edits', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-08T12:00:00Z'))
    const onCancel = vi.fn(), onReorder = vi.fn(), onEditBid = vi.fn()
    await act(async () => { renderer = create(React.createElement(RosterClaimItem, { claim, cancellingId: null, waiverMode: 'faab', onCancel, onReorder, onEditBid })) })
    const text = JSON.stringify(renderer!.toJSON())
    expect(text).toContain(`Processes ${claimProcessTimeLabel(claim.clearsAt ?? null)}`)
    expect(text).toContain('Bid $10')
    expect(text).not.toContain('Order ')
    expect(text).not.toContain('Waiver priority')
    await act(async () => { renderer!.root.findByProps({ accessibilityLabel: 'Move Player A claim up' }).props.onPress() })
    await act(async () => { renderer!.root.findByProps({ accessibilityLabel: 'Move Player A claim down' }).props.onPress() })
    await act(async () => { renderer!.root.findByProps({ accessibilityLabel: 'Save bid for Player A' }).props.onPress() })
    await act(async () => { renderer!.root.findByProps({ accessibilityLabel: 'Cancel claim for Player A' }).props.onPress() })
    expect(onReorder.mock.calls).toEqual([['claim', 'up'], ['claim', 'down']])
    expect(onEditBid).toHaveBeenCalledWith(claim, 10)
    expect(onCancel).toHaveBeenCalledWith('claim')
})

it.each([['succeeded', 'Succeeded'], ['failed_roster', 'Failed: roster full'], ['failed_priority', 'Failed: outbid']])('keeps the %s result text', async (status, expected) => {
    await act(async () => { renderer = create(React.createElement(RosterClaimItem, { claim: { ...claim, status }, cancellingId: null, onCancel: vi.fn(), onReorder: vi.fn(), onEditBid: vi.fn() })) })
    expect(JSON.stringify(renderer!.toJSON())).toContain(expected)
    expect(renderer!.root.findAllByProps({ accessibilityLabel: 'Cancel claim for Player A' })).toHaveLength(0)
})
