import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { useMemberClaimsStream } from '@/hooks/use-member-claims-stream'
import { listenForMemberClaimsChanges } from '@/lib/claim-updates'
import { setSessionOwner } from '@/lib/session-cache-registry'

const boundary = vi.hoisted(() => ({
    subscribe: vi.fn(), stop: vi.fn(),
}))
vi.mock('@/lib/realtime', () => ({
    subscribeToTableChanges: boundary.subscribe,
    unsubscribeFromTableChanges: boundary.stop,
    reportRealtimeCleanup: vi.fn(),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('owns one selected-member stream, recovers joins and refuses callbacks after owner changes', async () => {
    setSessionOwner('user-a')
    const a = vi.fn(), b = vi.fn()
    const stopA = listenForMemberClaimsChanges('member-a', a)
    const stopB = listenForMemberClaimsChanges('member-b', b)
    const Probe = ({ member, user }: { member: string; user: string }) => {
        useMemberClaimsStream(member, user, true)
        return null
    }
    let renderer: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe, { member: 'member-a', user: 'user-a' })) })
    const first = boundary.subscribe.mock.calls[0][1]
    expect(first.watches[0].filter).toBe('member_id=eq.member-a')
    first.watches[0].onChange()
    first.onStatus('SUBSCRIBED')
    expect(a).toHaveBeenCalledTimes(2)
    await act(async () => { renderer.update(React.createElement(Probe, { member: 'member-a', user: 'user-a' })) })
    expect(boundary.subscribe).toHaveBeenCalledTimes(1)
    setSessionOwner('user-b')
    first.watches[0].onChange()
    expect(a).toHaveBeenCalledTimes(2)
    await act(async () => { renderer.update(React.createElement(Probe, { member: 'member-b', user: 'user-b' })) })
    const second = boundary.subscribe.mock.calls[1][1]
    expect(second.watches[0].filter).toBe('member_id=eq.member-b')
    first.onStatus('SUBSCRIBED')
    second.watches[0].onChange()
    expect(a).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenCalledTimes(1)
    await act(async () => { renderer.unmount() })
    second.watches[0].onChange()
    expect(b).toHaveBeenCalledTimes(1)
    expect(boundary.stop).toHaveBeenCalledTimes(2)
    stopA(); stopB()
})
