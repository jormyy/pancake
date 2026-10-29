import { afterEach, beforeEach, vi } from 'vitest'
import '@/lib/supabase'
import { clearScreenViews } from '@/lib/cache/screen-cache'

const boundary = vi.hoisted(() => ({
    owner: 'account', generation: 0, online: true, focused: true, hidden: false,
    version: '1', changes: [] as { version: string; topic: string; scope: Record<string, unknown>; created_at: string }[],
    read: vi.fn<(scope: { screen: string; leagueId: string | null; memberId: string | null; params: Record<string, unknown> }) => Promise<unknown>>(),
    listeners: new Map<string, Set<(snapshot: { version: string; changes: { version: string; topic: string; scope: Record<string, unknown>; created_at: string }[] }) => void>>(),
}))
export { boundary }
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => boundary.focused }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) } }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => boundary.online }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionOwner: () => boundary.owner, sessionGeneration: () => boundary.generation, onSessionCachesCleared: () => {} }))
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: boundary.owner }, access_token: 'fixture' } } }) } } }))
vi.mock('@/lib/league-version', () => ({
    compareLeagueVersions: (a: string, b: string) => BigInt(a) > BigInt(b) ? 1 : BigInt(a) < BigInt(b) ? -1 : 0,
    leagueVersionSnapshot: () => ({ version: boundary.version, changes: boundary.changes }),
    readLeagueVersion: async () => ({ version: boundary.version, changes: boundary.changes }),
    subscribeLeagueVersion: (league: string, listener: (snapshot: { version: string; changes: { version: string; topic: string; scope: Record<string, unknown>; created_at: string }[] }) => void) => {
        const listeners = boundary.listeners.get(league) ?? new Set()
        listeners.add(listener); boundary.listeners.set(league, listeners)
        return () => { listeners.delete(listener) }
    },
}))

beforeEach(() => {
    clearScreenViews(); boundary.listeners.clear(); boundary.owner = 'account'; boundary.generation += 1
    boundary.online = true; boundary.focused = true; boundary.hidden = false; boundary.version = '1'; boundary.changes = []
    boundary.read.mockReset()
    vi.stubGlobal('navigator', { get onLine() { return boundary.online } })
    vi.stubGlobal('window', new EventTarget())
    const page = new EventTarget()
    Object.defineProperty(page, 'visibilityState', { get: () => boundary.hidden ? 'hidden' : 'visible' })
    vi.stubGlobal('document', page)
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
        const url = new URL(input)
        const view = await boundary.read({ screen: url.pathname.split('/').at(-1)!, leagueId: url.searchParams.get('leagueId'), memberId: url.searchParams.get('memberId'), params: JSON.parse(url.searchParams.get('params') ?? '{}') })
        return new Response(JSON.stringify({ ok: true, view }), { status: 200 })
    }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

export function bumpView(league = 'league', topic = 'catchup', tables?: string[]) {
    boundary.version = String(Number(boundary.version) + 1)
    boundary.changes = [{ version: boundary.version, topic, scope: { topics: [topic], ...(tables ? { tables } : {}) }, created_at: new Date().toISOString() }]
    for (const listener of boundary.listeners.get(league) ?? []) listener({ version: boundary.version, changes: boundary.changes })
}

export function held<Value>() {
    let resolve!: (value: Value) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}
