import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: 'account' }, access_token: 'fixture' } } }) } } }))
vi.mock('@/lib/cache/screen-cache', () => ({ refreshScreenVersions: async () => {}, invalidateScreenViews() {} }))

const key = 'pancake:offline-mutations:v1'
const values = new Map<string, string>()
let online = false
const storage = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value) },
    removeItem: (name: string) => { values.delete(name) },
}

beforeEach(() => {
    vi.resetModules()
    values.clear()
    online = false
    vi.stubGlobal('navigator', { get onLine() { return online } })
    vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { search: '' }, localStorage: storage }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('settled mutation persistence across reload', () => {
    it.each(['once', 'always'] as const)('preserves a newly saved action from another tab when completion writes fail %s', async failure => {
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const firstTab = await import('@/lib/cache/mutation-queue')
        const input = { accountId: 'account', leagueId: null, rowIds: [], path: '/action', body: '{}' }
        const result = firstTab.queueMutation(input)
        const completedId = firstTab.pendingMutations()[0].id
        vi.resetModules()
        const secondSession = await import('@/lib/session-cache-registry')
        secondSession.setSessionOwner('account')
        const secondTab = await import('@/lib/cache/mutation-queue')
        void secondTab.queueMutation({ ...input, path: '/unrelated' })
        const sibling = secondTab.pendingMutations()[1]
        const save = vi.spyOn(storage, 'setItem')
        if (failure === 'once') save.mockImplementationOnce(() => { throw new Error('Disk full') })
        else save.mockImplementation(() => { throw new Error('Disk full') })
        online = true
        const sender = vi.fn(async () => 'saved')
        firstTab.configureMutationReplay(sender)
        await firstTab.replayMutations()
        await expect(result).resolves.toBe('saved')
        expect(sender).toHaveBeenCalledOnce()
        vi.resetModules()
        const restoredSession = await import('@/lib/session-cache-registry')
        restoredSession.setSessionOwner('account')
        const restored = await import('@/lib/cache/mutation-queue')
        expect(restored.pendingMutations()).toContainEqual(sibling)
        if (failure === 'once') expect(restored.pendingMutations().some(job => job.id === completedId)).toBe(false)
    })

    it.each(['once', 'always'] as const)('creates one mock room when completion writes fail %s', async failure => {
        const drafts: { id: string }[] = []
        const send = vi.fn(async () => {
            const draft = { id: `draft-${drafts.length + 1}` }
            drafts.push(draft)
            return Response.json({ ok: true, draft })
        })
        vi.stubGlobal('fetch', send)
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const rooms = await import('@/lib/mockDraftRooms')
        const queue = await import('@/lib/cache/mutation-queue')
        const result = rooms.createMockDraftRoom({ leagueId: 'league', memberId: 'member', draftType: 'snake' })
        const save = vi.spyOn(storage, 'setItem')
        if (failure === 'once') save.mockImplementationOnce(() => { throw new Error('Disk full') })
        else save.mockImplementation(() => { throw new Error('Disk full') })
        online = true
        await queue.replayMutations()
        await expect(result).resolves.toEqual({ id: 'draft-1' })
        expect(queue.pendingMutations()).toEqual([])
        vi.resetModules()
        const restoredSession = await import('@/lib/session-cache-registry')
        restoredSession.setSessionOwner('account')
        await import('@/lib/mockDraftRooms')
        const restored = await import('@/lib/cache/mutation-queue')
        await restored.replayMutations()
        expect(send).toHaveBeenCalledOnce()
        expect(drafts).toEqual([{ id: 'draft-1' }])
        expect(restored.pendingMutations()).toEqual([])
    })

    it('preserves another account’s pending action when retrying the completion write', async () => {
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('other')
        const queue = await import('@/lib/cache/mutation-queue')
        const input = { leagueId: 'league', rowIds: [], path: '/action', body: '{}' }
        const otherResult = queue.queueMutation({ ...input, accountId: 'other' })
        const otherRejection = expect(otherResult).rejects.toThrow('account changed')
        const other = queue.pendingMutations()[0]
        session.setSessionOwner('account')
        await otherRejection
        const result = queue.queueMutation({ ...input, accountId: 'account' })
        vi.spyOn(storage, 'setItem').mockImplementationOnce(() => { throw new Error('Disk full') })
        online = true
        const sender = vi.fn(async () => 'saved')
        queue.configureMutationReplay(sender)
        await queue.replayMutations()
        await expect(result).resolves.toBe('saved')
        expect(JSON.parse(values.get(key)!)).toEqual([other])
        vi.resetModules()
        const restoredSession = await import('@/lib/session-cache-registry')
        restoredSession.setSessionOwner('other')
        const restored = await import('@/lib/cache/mutation-queue')
        expect(restored.pendingMutations()).toEqual([other])
    })

    it('keeps the sender result when both completion persistence and removal fail', async () => {
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const queue = await import('@/lib/cache/mutation-queue')
        const result = queue.queueMutation({ accountId: 'account', leagueId: null, rowIds: [], path: '/action', body: '{}' })
        vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
        vi.spyOn(storage, 'removeItem').mockImplementation(() => { throw new Error('Storage unavailable') })
        online = true
        queue.configureMutationReplay(async () => 'saved')
        await queue.replayMutations()
        await expect(result).resolves.toBe('saved')
        expect(queue.pendingMutations()).toEqual([])
        expect(JSON.parse(values.get(key)!)).toHaveLength(1)
    })
})
