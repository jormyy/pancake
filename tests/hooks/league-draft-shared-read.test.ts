import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useLeagueDraftController } from '@/hooks/use-league-draft-controller'
import { useDraftRoomLauncher } from '@/hooks/use-draft-room-launcher'
import { clearSessionCaches, setSessionOwner } from '@/lib/session-cache-registry'

const boundary = vi.hoisted(() => ({ from: vi.fn(), push: vi.fn(), alert: vi.fn(), save: vi.fn(), member: 'member', focused: true }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: boundary.from } }))
vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn() }))
vi.mock('@/lib/realtime', () => ({ subscribeToTableChanges: vi.fn(), unsubscribeFromTableChanges: vi.fn() }))
vi.mock('@/lib/rookieDraft', () => ({ getActiveRookieDraft: vi.fn(), reseedRookieDraftPicks: vi.fn(), startRookieDraft: vi.fn() }))
vi.mock('@/lib/alert', () => ({ showAlert: boundary.alert, showSuccess: vi.fn(), confirmAction: vi.fn() }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => undefined, writePersistentCache: boundary.save }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: boundary.push }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: boundary.member, leagues: { id: 'league' } } }) }))
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) } }))
vi.mock('@react-navigation/native', async () => {
    const ReactModule = await import('react')
    return {
        useIsFocused: () => boundary.focused,
        useFocusEffect: (callback: React.EffectCallback) => ReactModule.useEffect(() => {
            if (boundary.focused) return callback()
        }, [callback, boundary.focused]),
    }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Response = { data: unknown; error: Error | null }
let reads: { table: string; resolve: (response: Response) => void }[]
let renderer: ReactTestRenderer | undefined
let controller!: ReturnType<typeof useLeagueDraftController>
let launcher!: ReturnType<typeof useDraftRoomLauncher>
let visible: boolean
let online: boolean
let page: EventTarget
let network: EventTarget
const Controller = ({ authorized }: { authorized: boolean }) => {
    controller = useLeagueDraftController('league', { memberId: boundary.member, authorized })
    return null
}
const Launcher = () => { launcher = useDraftRoomLauncher('league', { renderAuctionInline: true }); return null }
const view = (withController = true, authorized = true) => React.createElement(React.Fragment, null,
    withController && React.createElement(Controller, { key: 'controller', authorized }),
    React.createElement(Launcher, { key: 'launcher' }),
)
const mount = async (authorized = true) => { await act(async () => { renderer = create(view(true, authorized)) }) }
const resolveRead = async (index: number, data: unknown, error: Error | null = null) => {
    await act(async () => { reads[index].resolve({ data, error }) })
}
const row = (id: string, draftType = 'auction') => ({ id, draft_type: draftType, status: 'in_progress' })
const tables = () => reads.map(read => read.table)

beforeEach(() => {
    clearSessionCaches()
    setSessionOwner('actor')
    vi.clearAllMocks()
    boundary.member = 'member'
    boundary.focused = true
    visible = true
    online = true
    reads = []
    page = new EventTarget()
    network = new EventTarget()
    Object.defineProperty(page, 'visibilityState', { get: () => visible ? 'visible' : 'hidden' })
    vi.stubGlobal('document', page)
    vi.stubGlobal('window', network)
    vi.stubGlobal('navigator', { get onLine() { return online } })
    boundary.from.mockImplementation((table: string) => {
        const chain = {
            select: () => chain, eq: () => chain, in: () => chain, order: () => chain, limit: () => chain,
            maybeSingle: () => new Promise<Response>(resolve => { reads.push({ table, resolve }) }),
        }
        return chain
    })
})

afterEach(async () => {
    await act(async () => { renderer?.unmount() })
    renderer = undefined
    clearSessionCaches()
    vi.unstubAllGlobals()
})

it('shares a pending status lookup between the actual controller and launcher', async () => {
    await mount()
    await act(async () => { void launcher.openDraftRoom() })
    expect(tables()).toEqual(['drafts'])
    await resolveRead(0, row('shared'))
    expect(controller.activeDraft?.id).toBe('shared')
    expect(launcher.draft?.id).toBe('shared')
    expect(boundary.push).not.toHaveBeenCalled()
})

it('joins a launcher lookup for an explicit controller join without trusting the displayed draft', async () => {
    await mount()
    await resolveRead(0, row('displayed'))
    let join!: Promise<void>
    await act(async () => { void launcher.openDraftRoom(); join = controller.handleJoinDraftRoom() })
    expect(tables()).toEqual(['drafts', 'drafts'])
    await resolveRead(1, row('current'))
    await act(async () => { await join })
    expect(launcher.draft?.id).toBe('current')
    expect(boundary.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/(modals)/draft-room', params: { draftId: 'current' } })
    expect(controller.draftLoading).toBe(false)
})

it.each(['hidden', 'offline'] as const)('stops shared fallback while %s and joins one fresh lookup on return', async kind => {
    await mount()
    await act(async () => { void launcher.openDraftRoom() })
    const suspended = [...reads]
    await act(async () => {
        if (kind === 'hidden') { visible = false; page.dispatchEvent(new Event('visibilitychange')) }
        else { online = false; network.dispatchEvent(new Event('offline')) }
    })
    await act(async () => { for (const read of suspended) read.resolve({ data: null, error: null }) })
    expect(reads.filter(read => read.table === 'leagues')).toHaveLength(0)
    await act(async () => {
        if (kind === 'hidden') { visible = true; page.dispatchEvent(new Event('visibilitychange')) }
        else { online = true; network.dispatchEvent(new Event('online')) }
    })
    expect(tables()).toEqual(['drafts', 'drafts'])
    await resolveRead(1, row('resumed'))
    expect(controller.activeDraft?.id).toBe('resumed')
    expect(launcher.draft?.id).toBe('resumed')
})

it('stops the completed-rookie fallback after suspension during the league phase', async () => {
    await mount()
    await resolveRead(0, null)
    expect(tables()).toEqual(['drafts', 'leagues'])
    await act(async () => { visible = false; page.dispatchEvent(new Event('visibilitychange')) })
    await resolveRead(1, { status: 'drafting' })
    expect(tables()).toEqual(['drafts', 'leagues'])
    expect(boundary.save).not.toHaveBeenCalled()
})

it('releases a former membership and does not revive it when that membership returns', async () => {
    await mount()
    await act(async () => { void launcher.openDraftRoom() })
    await act(async () => { boundary.member = 'other'; renderer!.update(view()) })
    await act(async () => { void launcher.openDraftRoom() })
    await act(async () => { boundary.member = 'member'; renderer!.update(view()) })
    await act(async () => { void launcher.openDraftRoom() })
    expect(tables()).toEqual(['drafts', 'drafts', 'drafts'])
    await resolveRead(0, null)
    await resolveRead(1, row('former'))
    expect(tables()).toEqual(['drafts', 'drafts', 'drafts'])
    expect(controller.activeDraft).toBeNull()
    expect(launcher.draft).toBeNull()
    await resolveRead(2, row('current'))
    expect(controller.activeDraft?.id).toBe('current')
    expect(launcher.draft?.id).toBe('current')
})

it('keeps the launcher fallback alive after only the controller unmounts', async () => {
    await mount()
    await act(async () => { void launcher.openDraftRoom() })
    await act(async () => { renderer!.update(view(false)) })
    await resolveRead(0, null)
    expect(tables()).toEqual(['drafts', 'leagues'])
    await resolveRead(1, { status: 'drafting' })
    await resolveRead(2, row('rookie', 'snake'))
    expect(launcher.draft?.id).toBe('rookie')
    expect(boundary.save).toHaveBeenCalledExactlyOnceWith('pancake:draft-launcher:v1:["actor","league","member"]', { draft: launcher.draft })
    expect(boundary.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/(modals)/rookie-draft-room', params: { draftId: 'rookie' } })
})

it('does not show a suspended join failure after the route returns', async () => {
    await mount()
    await resolveRead(0, row('displayed'))
    let join!: Promise<void>
    await act(async () => { join = controller.handleJoinDraftRoom() })
    await act(async () => { boundary.focused = false; renderer!.update(view()) })
    await act(async () => { boundary.focused = true; renderer!.update(view()) })
    await resolveRead(1, null, new Error('former join failed'))
    await act(async () => { await join })
    expect(boundary.alert).not.toHaveBeenCalled()
    expect(boundary.push).not.toHaveBeenCalled()
    expect(controller.draftLoading).toBe(false)
    await resolveRead(2, row('current'))
    expect(controller.activeDraft?.id).toBe('current')
})

it('releases a hidden explicit join before fallback and refreshes status without reopening it', async () => {
    await mount()
    await resolveRead(0, row('displayed'))
    let join!: Promise<void>
    await act(async () => { join = controller.handleJoinDraftRoom() })
    await act(async () => { visible = false; page.dispatchEvent(new Event('visibilitychange')) })
    await resolveRead(1, null)
    await act(async () => { await join })
    expect(tables()).toEqual(['drafts', 'drafts'])
    expect(controller.draftLoading).toBe(false)
    await act(async () => { visible = true; page.dispatchEvent(new Event('visibilitychange')) })
    expect(tables()).toEqual(['drafts', 'drafts', 'drafts'])
    await resolveRead(2, row('current'))
    expect(controller.activeDraft?.id).toBe('current')
    expect(boundary.push).not.toHaveBeenCalled()
    expect(boundary.alert).not.toHaveBeenCalled()
})

it('shares a retry after current readers receive a query failure', async () => {
    await mount()
    await act(async () => { void launcher.openDraftRoom() })
    expect(tables()).toEqual(['drafts'])
    await resolveRead(0, null, new Error('unavailable'))
    expect(controller.activeDraftError).toBe('unavailable')
    expect(launcher.draftError).toBe('unavailable')
    await act(async () => { void controller.retryActiveDraft(); void launcher.openDraftRoom() })
    expect(tables()).toEqual(['drafts', 'drafts'])
    await resolveRead(1, row('recovered'))
    expect(controller.activeDraft?.id).toBe('recovered')
    expect(controller.activeDraftError).toBeNull()
    expect(launcher.draft?.id).toBe('recovered')
    expect(launcher.draftError).toBeNull()
})

it('refuses former-session actions before a parent can rerender', async () => {
    await mount()
    setSessionOwner('replacement')
    await act(async () => { void controller.handleJoinDraftRoom() })
    expect(tables()).toEqual(['drafts'])
    await resolveRead(0, row('former'))
    expect(boundary.save).not.toHaveBeenCalled()
    expect(boundary.alert).not.toHaveBeenCalled()
    expect(boundary.push).not.toHaveBeenCalled()
})

it('does not admit status or join actions for unvalidated authority', async () => {
    await mount(false)
    await act(async () => { await controller.handleJoinDraftRoom(); await controller.retryActiveDraft() })
    expect(reads).toHaveLength(0)
    expect(boundary.push).not.toHaveBeenCalled()
})
