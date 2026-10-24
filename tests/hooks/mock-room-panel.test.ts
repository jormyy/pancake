import '@/tests/helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MockRoomsPanel } from '@/components/league/MockRoomsPanel'
import type { MockDraftRoom } from '@/lib/mockDraftRooms'

vi.mock('@/components/ui/ScreenStatusOverlay', () => ({ ScreenStatusScrollView: 'ScrollView' }))
vi.mock('@/hooks/use-web-viewport', () => ({ useWebViewport: () => ({ viewportHeight: 900 }) }))
vi.mock('@/components/ui', () => ({ Button: 'Button', usePageMetrics: () => ({ padX: 16 }) }))
const noop = () => {}
const room = (id: string, offset: number): MockDraftRoom => ({
    id, leagueId: 'league', draftType: 'auction', status: 'pending', roomStatus: 'scheduled',
    roomName: id, scheduledAt: new Date(Date.now() + offset).toISOString(), startedAt: null,
    completedAt: null, createdByMemberId: 'creator', creatorTeamName: 'Creator Team', pickTimerSeconds: 30,
    rounds: null, nominationOrderMode: 'user_nominated', timerExpiryBehavior: 'auction_no_bid',
    participants: Array.from({ length: 10 }, (_, index) => ({ memberId: `member-${index}`, teamName: `Team ${index}`, joinedAt: '' })),
    isJoined: true, isCreator: true,
})
const props = (rooms: MockDraftRoom[]) => ({
    rooms, roomName: '', onRoomNameChange: noop, roomDraftType: 'auction' as const, onRoomDraftTypeChange: noop,
    roomScheduledAt: '', onRoomScheduledAtChange: noop, roomSubmitting: false, draftLoading: false,
    nominationMode: 'user_nominated' as const, onNominationModeChange: noop, draftTimerSeconds: 30,
    onDraftTimerSecondsChange: noop, rookieRounds: 3 as const, onRookieRoundsChange: noop,
    rookieTimerExpiryBehavior: 'auto_pick' as const, onRookieTimerExpiryBehaviorChange: noop,
    onCreateRoom: noop, onOpenRoom: noop, onJoinRoom: noop, onLeaveRoom: noop, onStartRoom: noop, onDeleteRoom: noop,
})
let renderer: ReactTestRenderer | undefined
const starts = () => renderer!.root.findAllByType('Pressable' as React.ElementType)
    .filter(node => /^Start /.test(node.props.accessibilityLabel ?? ''))
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-24T12:00:00Z')) })
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; vi.useRealTimers() })

it('shows Start when each scheduled room reaches its time without another fetch', async () => {
    await act(async () => { renderer = create(React.createElement(MockRoomsPanel, props([room('First', 1000), room('Second', 2000)]))) })
    expect(starts()).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(starts().map(node => node.props.accessibilityLabel)).toEqual(['Start First'])
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(starts().map(node => node.props.accessibilityLabel)).toEqual(['Start First', 'Start Second'])
    expect(vi.getTimerCount()).toBe(0)
})

it('shows the creator and joined count without listing every team', async () => {
    await act(async () => { renderer = create(React.createElement(MockRoomsPanel, props([room('Mock', -1000)]))) })
    const text = renderer!.root.findAllByType('Text' as React.ElementType)
        .map(node => node.children.join('')).find(value => value.startsWith('Creator:'))
    expect(text).toBe('Creator: Creator Team · 10 joined')
    const card = renderer!.root.findAllByProps({ role: 'listitem' })[0]
    expect(card.props.accessibilityLabel).toContain('10 joined')
    expect(card.props.accessibilityLabel).not.toContain('Team 0')
})

it('clears the scheduled start timeout when the panel closes', async () => {
    await act(async () => { renderer = create(React.createElement(MockRoomsPanel, props([room('Later', 1000)]))) })
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => renderer!.unmount())
    renderer = undefined
    expect(vi.getTimerCount()).toBe(0)
})

it('catches a start time that passes between rendering and scheduling the timeout', async () => {
    const rooms = [room('Due', 1000)]
    const Probe = () => {
        React.useLayoutEffect(() => { vi.setSystemTime(Date.now() + 1000) }, [])
        return React.createElement(MockRoomsPanel, props(rooms))
    }
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(starts().map(node => node.props.accessibilityLabel)).toEqual(['Start Due'])
    expect(vi.getTimerCount()).toBe(0)
})
