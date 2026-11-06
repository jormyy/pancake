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
    it('repairs a failed rejection save on the next enqueue before reload', async () => {
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const queue = await import('@/lib/cache/mutation-queue')
        const input = { accountId: 'account', leagueId: null, rowIds: [], path: '/first', body: '{}' }
        queue.configureMutationReplay(async () => { throw new Error('Server rejected action') })
        const result = queue.queueMutation(input).catch(error => error.message)
        vi.spyOn(storage, 'setItem').mockImplementationOnce(() => { throw new Error('Disk full') })
        online = true
        await queue.replayMutations()
        await expect(result).resolves.toBe('Server rejected action')
        void queue.queueMutation({ ...input, path: '/second' })
        const memory = queue.pendingMutations().map(job => job.status)
        const disk = JSON.parse(values.get(key)!).map((job: { status: string }) => job.status)
        vi.resetModules()
        const restoredSession = await import('@/lib/session-cache-registry')
        restoredSession.setSessionOwner('account')
        const restored = await import('@/lib/cache/mutation-queue')
        const sends: string[] = []
        restored.configureMutationReplay(async job => { sends.push(job.path) })
        await restored.replayMutations()
        console.log(JSON.stringify({ memory, disk, sendsWithoutRetry: sends }))
        expect(disk).toEqual(['failed', 'pending'])
        expect(sends).toEqual([])
        expect(restored.pendingMutations()[0]).toMatchObject({ status: 'failed', error: 'Server rejected action' })
    })

    async function reviewSetup() {
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const rooms = await import('@/lib/mockDraftRooms')
        const queue = await import('@/lib/cache/mutation-queue')
        return { session, queue, create: () => rooms.createMockDraftRoom({ leagueId: 'league', memberId: 'member', draftType: 'snake' }) }
    }

    it('does not replay completed rooms after two failed writes and storage recovery', async () => {
        let created = 0
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, draft: { id: ++created } })))
        const { queue, create } = await reviewSetup()
        const results = [create(), create()]
        vi.spyOn(storage, 'setItem')
            .mockImplementationOnce(() => { throw Error('Disk full') })
            .mockImplementationOnce(() => { throw Error('Disk full') })
        online = true
        await queue.replayMutations()
        await Promise.all(results)
        console.log('memory pending:', queue.pendingMutations().length)
        console.log('persisted pending:', JSON.parse(values.get(key) ?? '[]').length)
        vi.resetModules()
        const restored = await reviewSetup()
        await restored.queue.replayMutations()
        console.log('rooms created after reload:', created)
        expect(created).toBe(2)
        expect(JSON.parse(values.get(key) ?? '[]')).toEqual([])
    })

    it('does not duplicate an unfinished room when returning to its account', async () => {
        let finish!: () => void
        let sends = 0
        vi.stubGlobal('fetch', vi.fn(async () => {
            const id = ++sends
            if (id === 1) await new Promise<void>(resolve => { finish = resolve })
            return Response.json({ ok: true, draft: { id } })
        }))
        const { session, queue, create } = await reviewSetup()
        const result = create()
        const rejected = expect(result).rejects.toThrow('account changed')
        online = true
        const original = queue.replayMutations()
        for (let index = 0; index < 8; index++) await Promise.resolve()
        session.setSessionOwner('other')
        session.setSessionOwner('account')
        const next = queue.replayMutations()
        for (let index = 0; index < 8; index++) await Promise.resolve()
        console.log('sends before original completes:', sends)
        finish()
        await Promise.all([original, next, rejected])
        console.log('sends after original completes:', sends)
        expect(sends).toBe(1)
    })


    it.each(['saved', 'failed'] as const)('keeps a %s result after returning to the account before completion without replaying', async outcome => {
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const queue = await import('@/lib/cache/mutation-queue')
        let finish!: () => void
        const sender = vi.fn(async () => {
            await new Promise<void>(resolve => { finish = resolve })
            if (outcome === 'failed') throw new Error('Send failed')
            return 'saved'
        })
        queue.configureMutationReplay(sender)
        const result = queue.queueMutation({ accountId: 'account', leagueId: null, rowIds: [], path: '/draft/mock-room/create', body: '{}' })
        const rejected = expect(result).rejects.toThrow('account changed')
        const job = queue.pendingMutations()[0]
        online = true
        const original = queue.replayMutations()
        session.setSessionOwner('other')
        session.setSessionOwner('account')
        expect(queue.pendingMutations()).toEqual([job])
        finish()
        await Promise.all([original, rejected])
        const expected = outcome === 'saved' ? [] : [{ ...job, status: 'failed', error: 'Send failed' }]
        expect(JSON.parse(values.get(key)!)).toEqual(expected)
        expect(queue.mutationSnapshot()).toEqual(expected)
        expect(queue.pendingMutations()).toEqual(expected)
        await queue.replayMutations()
        expect(sender).toHaveBeenCalledOnce()
    })

    it('removes every completed room when a later write succeeds without losing another tab job', async () => {
        let created = 0
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, draft: { id: ++created } })))
        const { queue, create } = await reviewSetup()
        const results = [create(), create(), create()]
        vi.resetModules()
        const other = await reviewSetup()
        void other.queue.queueMutation({ accountId: 'account', leagueId: null, rowIds: [], path: '/unrelated', body: '{}' })
        const sibling = other.queue.pendingMutations()[3]
        vi.spyOn(storage, 'setItem')
            .mockImplementationOnce(() => { throw Error('Disk full') })
            .mockImplementationOnce(() => { throw Error('Disk full') })
        online = true
        await queue.replayMutations()
        await Promise.all(results)
        expect(created).toBe(3)
        expect(JSON.parse(values.get(key)!)).toEqual([sibling])
        online = false
        vi.resetModules()
        const restored = await reviewSetup()
        expect(restored.queue.pendingMutations()).toEqual([sibling])
    })

    it('preserves another tab’s action through the next local completion', async () => {
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const firstTab = await import('@/lib/cache/mutation-queue')
        const input = { accountId: 'account', leagueId: null, rowIds: [], path: '/first', body: '{}' }
        const first = firstTab.queueMutation(input)
        const second = firstTab.queueMutation({ ...input, path: '/second' })
        vi.resetModules()
        const secondSession = await import('@/lib/session-cache-registry')
        secondSession.setSessionOwner('account')
        const secondTab = await import('@/lib/cache/mutation-queue')
        void secondTab.queueMutation({ ...input, path: '/unrelated' })
        const sibling = secondTab.pendingMutations()[2]
        vi.spyOn(storage, 'setItem').mockImplementationOnce(() => { throw new Error('Disk full') })
        const sender = vi.fn(async () => 'saved')
        online = true
        firstTab.configureMutationReplay(sender)
        await firstTab.replayMutations()
        await expect(first).resolves.toBe('saved')
        await expect(second).resolves.toBe('saved')
        expect(sender).toHaveBeenCalledTimes(2)
        expect(JSON.parse(values.get(key)!)).toEqual([sibling])
        vi.resetModules()
        const restoredSession = await import('@/lib/session-cache-registry')
        restoredSession.setSessionOwner('account')
        const restored = await import('@/lib/cache/mutation-queue')
        expect(restored.pendingMutations()).toEqual([sibling])
    })

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
