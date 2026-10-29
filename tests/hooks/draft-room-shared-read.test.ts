import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDraftRoomLauncher } from '@/hooks/use-draft-room-launcher'
import { clearSessionCaches, setSessionOwner } from '@/lib/session-cache-registry'
import { acquireJoinableDraft } from '@/lib/draft'

const boundary = vi.hoisted(() => ({ from: vi.fn(), push: vi.fn(), member: 'member' }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: boundary.from } }))
vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn() }))
vi.mock('@/lib/realtime', () => ({ subscribeToTableChanges: vi.fn(), unsubscribeFromTableChanges: vi.fn() }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) } }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: boundary.push }) }))
vi.mock('@/lib/alert', () => ({ showAlert: vi.fn() }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: boundary.member, leagues: { id: 'league' } } }) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Response = { data: unknown; error: Error | null }
let reads: { table: string; resolve: (response: Response) => void }[]
let renderer: ReactTestRenderer | undefined
let visible: boolean
let page: EventTarget
const launchers = new Map<string, ReturnType<typeof useDraftRoomLauncher>>()
const Probe = ({ name, member }: { name: string; member?: string }) => {
    launchers.set(name, useDraftRoomLauncher('league', { scopeKey: member, renderAuctionInline: true }))
    return null
}
const pair = (first = true) => React.createElement(React.Fragment, null,
    first && React.createElement(Probe, { key: 'first', name: 'first', member: 'member' }),
    React.createElement(Probe, { key: 'second', name: 'second', member: 'member' }),
)
const resolveRead = async (index: number, data: unknown) => {
    await act(async () => { reads[index].resolve({ data, error: null }) })
}

beforeEach(() => {
    clearSessionCaches()
    setSessionOwner('actor')
    reads = []
    launchers.clear()
    boundary.push.mockClear()
    boundary.member = 'member'
    visible = true
    page = new EventTarget()
    Object.defineProperty(page, 'visibilityState', { get: () => visible ? 'visible' : 'hidden' })
    vi.stubGlobal('document', page)
    vi.stubGlobal('navigator', { onLine: true })
    boundary.from.mockImplementation((table: string) => {
        const chain = {
            select: () => chain, eq: () => chain, in: () => chain,
            order: () => chain, limit: () => chain,
            maybeSingle: () => new Promise<Response>(resolve => { reads.push({ table, resolve }) }),
        }
        return chain
    })
})

afterEach(() => {
    act(() => { renderer?.unmount() })
    renderer = undefined
    clearSessionCaches()
    vi.unstubAllGlobals()
})

it('joins one pending read across separate launchers with the same identity', async () => {
    await act(async () => { renderer = create(pair()) })
    await act(async () => { void launchers.get('first')!.openDraftRoom(); void launchers.get('second')!.openDraftRoom() })
    expect(reads.map(read => read.table)).toEqual(['drafts'])
    await resolveRead(0, { id: 'auction', draft_type: 'auction' })
    expect(launchers.get('first')!.draft?.id).toBe('auction')
    expect(launchers.get('second')!.draft?.id).toBe('auction')
    await act(async () => { void launchers.get('second')!.openDraftRoom() })
    expect(reads).toHaveLength(2)
})

it('stops fallback after suspension and starts one fresh read on resume', async () => {
    await act(async () => { renderer = create(pair()) })
    await act(async () => { void launchers.get('first')!.openDraftRoom(); void launchers.get('second')!.openDraftRoom() })
    await act(async () => { visible = false; page.dispatchEvent(new Event('visibilitychange')) })
    await resolveRead(0, null)
    expect(reads.map(read => read.table)).toEqual(['drafts'])
    await act(async () => { visible = true; page.dispatchEvent(new Event('visibilitychange')) })
    expect(reads.map(read => read.table)).toEqual(['drafts', 'drafts'])
    await resolveRead(1, { id: 'resumed', draft_type: 'auction' })
    expect(launchers.get('first')!.draft?.id).toBe('resumed')
    expect(launchers.get('second')!.draft?.id).toBe('resumed')
})

it('releases a prior membership without borrowing its read when it becomes current again', async () => {
    const view = () => React.createElement(Probe, { name: 'first' })
    await act(async () => { renderer = create(view()) })
    await act(async () => { void launchers.get('first')!.openDraftRoom() })
    await act(async () => { boundary.member = 'replacement'; renderer!.update(view()) })
    await act(async () => { boundary.member = 'member'; renderer!.update(view()) })
    await act(async () => { void launchers.get('first')!.openDraftRoom() })
    expect(reads.map(read => read.table)).toEqual(['drafts', 'drafts'])
    await resolveRead(0, null)
    expect(reads.map(read => read.table)).toEqual(['drafts', 'drafts'])
    await act(async () => { void launchers.get('first')!.openDraftRoom() })
    expect(reads).toHaveLength(2)
    await resolveRead(1, { id: 'current', draft_type: 'auction' })
    expect(launchers.get('first')!.draft?.id).toBe('current')
})

it('keeps a shared fallback alive when only one launcher unmounts', async () => {
    await act(async () => { renderer = create(pair()) })
    await act(async () => { void launchers.get('first')!.openDraftRoom(); void launchers.get('second')!.openDraftRoom() })
    await act(async () => { renderer!.update(pair(false)) })
    await resolveRead(0, null)
    expect(reads.map(read => read.table)).toEqual(['drafts', 'leagues'])
    await resolveRead(1, { status: 'drafting' })
    await resolveRead(2, { id: 'rookie', draft_type: 'snake' })
    expect(launchers.get('second')!.draft?.id).toBe('rookie')
    expect(boundary.push).toHaveBeenCalledOnce()
})

it('joins a pending read acquired outside the launcher with the current membership', async () => {
    const external = acquireJoinableDraft('league', { memberId: 'member', includeCompletedRookie: true, canRead: () => true })
    await act(async () => { renderer = create(React.createElement(Probe, { name: 'first' })) })
    await act(async () => { void launchers.get('first')!.openDraftRoom() })
    expect(reads).toHaveLength(1)
    await resolveRead(0, { id: 'shared', draft_type: 'auction' })
    expect(await external.promise).toMatchObject({ id: 'shared' })
    expect(launchers.get('first')!.draft?.id).toBe('shared')
})
