import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: 'account' }, access_token: 'fixture' } } }) } } }))
vi.mock('@/lib/cache/screen-cache', () => ({ refreshScreenVersions: async () => {}, invalidateScreenViews() {} }))

const key = 'pancake:offline-mutations:v1'
const completionPrefix = 'pancake:offline-mutation-done:v1:'
const values = new Map<string, string>()
let online = false
const storage = {
    get length() { return values.size },
    key: (index: number) => [...values.keys()][index] ?? null,
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
    it.each(['offline', 'success', 'online rejection'] as const)('settles the caller when an externally completed send exits %s', async outcome => {
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const first = await import('@/lib/cache/mutation-queue')
        const input = { accountId: 'account', leagueId: null, rowIds: [], path: '/action', body: '{}' }
        const id = '10000000-0000-4000-8000-000000000001'
        const firstResult = first.queueMutation(input, id)
        vi.resetModules()
        const secondSession = await import('@/lib/session-cache-registry')
        secondSession.setSessionOwner('account')
        const second = await import('@/lib/cache/mutation-queue')
        let result = 'pending'
        void second.queueMutation(input, id).then(value => { result = String(value) }, error => { result = error.message })
        let fail!: (error: Error) => void
        let save!: (value: unknown) => void
        const send = vi.fn(() => new Promise((resolve, reject) => { save = resolve; fail = reject }))
        second.configureMutationReplay(send)
        online = true
        const inflight = second.replayMutations()
        first.configureMutationReplay(async () => 'saved')
        await first.replayMutations()
        await expect(firstResult).resolves.toBe('saved')
        expect(second.pendingMutations()).toEqual([])
        if (outcome === 'offline') online = false
        if (outcome === 'success') save('saved')
        else fail(new Error('Failed to fetch'))
        await inflight
        online = true
        await second.replayMutations()
        expect(result).toBe('This action completed in another tab. Refresh to see the result.')
        expect(second.pendingMutations()).toEqual([])
        expect(send).toHaveBeenCalledOnce()
    })

    it.each(['{invalid', 'null', '[null,42,"old"]'])('tolerates corrupt per-job completion %s', async corrupt => {
        const id = '10000000-0000-4000-8000-000000000001'
        values.set(completionPrefix + `account:${id}`, corrupt)
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const queue = await import('@/lib/cache/mutation-queue')
        queue.configureMutationReplay(async () => 'saved')
        const result = queue.queueMutation({ accountId: 'account', leagueId: null, rowIds: [], path: '/action', body: '{}' }, id)
        online = true
        await queue.replayMutations()
        await expect(result).resolves.toBe('saved')
        expect(Number(values.get(completionPrefix + `account:${id}`))).toBeGreaterThan(0)
    })

    it('prunes completion keys older than seven days while preserving recent and unrelated keys', async () => {
        const now = 2_000_000_000_000
        const age = 7 * 24 * 60 * 60 * 1000
        vi.spyOn(Date, 'now').mockReturnValue(now)
        values.set(completionPrefix + 'expired', String(now - age - 1))
        values.set(completionPrefix + 'boundary', String(now - age))
        values.set(completionPrefix + 'recent', String(now - 1))
        values.set(completionPrefix + 'corrupt', '{invalid')
        values.set('other-cache', String(now - age - 1))
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const queue = await import('@/lib/cache/mutation-queue')
        queue.configureMutationReplay(async () => 'saved')
        const result = queue.queueMutation({ accountId: 'account', leagueId: null, rowIds: [], path: '/action', body: '{}' })
        const id = queue.pendingMutations()[0].id
        online = true
        await queue.replayMutations()
        await expect(result).resolves.toBe('saved')
        expect(values.has(completionPrefix + 'expired')).toBe(false)
        expect(values.has(completionPrefix + 'corrupt')).toBe(false)
        expect(values.get(completionPrefix + 'boundary')).toBe(String(now - age))
        expect(values.get(completionPrefix + 'recent')).toBe(String(now - 1))
        expect(values.get(completionPrefix + `account:${id}`)).toBe(String(now))
        expect(values.has('other-cache')).toBe(true)
    })

    it.each(['length', 'key', 'prune'] as const)('keeps sender settlement when completion cleanup fails at %s', async fault => {
        values.set(completionPrefix + 'expired', '1')
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const queue = await import('@/lib/cache/mutation-queue')
        queue.configureMutationReplay(async () => 'saved')
        const result = queue.queueMutation({ accountId: 'account', leagueId: null, rowIds: [], path: '/action', body: '{}' })
        const id = queue.pendingMutations()[0].id
        if (fault === 'length') vi.spyOn(storage, 'length', 'get').mockImplementation(() => { throw new Error('Enumeration unavailable') })
        else if (fault === 'key') vi.spyOn(storage, 'key').mockImplementation(() => { throw new Error('Enumeration unavailable') })
        else vi.spyOn(storage, 'removeItem').mockImplementation(() => { throw new Error('Pruning unavailable') })
        online = true
        await queue.replayMutations()
        await expect(result).resolves.toBe('saved')
        expect(Number(values.get(completionPrefix + `account:${id}`))).toBeGreaterThan(0)
        expect(queue.pendingMutations()).toEqual([])
    })

    it('checks only known job completion keys during reads without enumerating storage', async () => {
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const queue = await import('@/lib/cache/mutation-queue')
        const input = { accountId: 'account', leagueId: null, rowIds: [], path: '/action', body: '{}' }
        void queue.queueMutation(input).catch(() => {})
        void queue.queueMutation(input).catch(() => {})
        const keys = queue.pendingMutations().map(job => completionPrefix + `account:${job.id}`)
        const get = vi.spyOn(storage, 'getItem')
        const enumerate = vi.spyOn(storage, 'key').mockImplementation(() => { throw new Error('Reads must not enumerate') })
        queue.mutationSnapshot()
        expect(get.mock.calls.map(([key]) => key).sort()).toEqual(keys.sort())
        expect(enumerate).not.toHaveBeenCalled()
    })

    it('keeps the uncertain failed job when the external completion record cannot be saved', async () => {
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const queue = await import('@/lib/cache/mutation-queue')
        queue.configureMutationReplay(async () => { throw new Error('Server rejected') })
        const result = queue.queueMutation({ accountId: 'account', leagueId: null, rowIds: [], path: '/action', body: '{}' }).catch(error => error.message)
        vi.spyOn(storage, 'setItem').mockImplementationOnce(() => { throw new Error('Disk full') })
        online = true
        await queue.replayMutations()
        await expect(result).resolves.toBe('Server rejected')
        vi.resetModules()
        const otherSession = await import('@/lib/session-cache-registry')
        otherSession.setSessionOwner('account')
        const other = await import('@/lib/cache/mutation-queue')
        vi.mocked(storage.setItem).mockImplementation((name, value) => {
            if (name.startsWith(completionPrefix)) throw new Error('Disk full')
            values.set(name, value)
        })
        other.configureMutationReplay(async () => 'saved')
        await other.replayMutations()
        expect(JSON.parse(values.get(key)!)).toEqual([])
        expect([...values.keys()].some(name => name.startsWith(completionPrefix))).toBe(false)
        session.setSessionOwner('other')
        session.setSessionOwner('account')
        await queue.replayMutations()
        expect(queue.pendingMutations()[0]).toMatchObject({ status: 'failed', error: 'Server rejected' })
    })

    it('rejects a current waiting caller instead of resending a job completed in another tab', async () => {
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const queue = await import('@/lib/cache/mutation-queue')
        const result = queue.queueMutation({ accountId: 'account', leagueId: null, rowIds: [], path: '/action', body: '{}' })
        const completedElsewhere = expect(result).rejects.toThrow('completed in another tab')
        vi.resetModules()
        const otherSession = await import('@/lib/session-cache-registry')
        otherSession.setSessionOwner('account')
        const other = await import('@/lib/cache/mutation-queue')
        online = true
        other.configureMutationReplay(async () => 'saved')
        await other.replayMutations()
        const sender = vi.fn(async () => 'duplicate')
        queue.configureMutationReplay(sender)
        await queue.replayMutations()
        await completedElsewhere
        expect(sender).not.toHaveBeenCalled()
        expect(queue.pendingMutations()).toEqual([])
    })

    it('rejects reuse of a request id after success even if a stale tab restores it', async () => {
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const queue = await import('@/lib/cache/mutation-queue')
        const input = { accountId: 'account', leagueId: null, rowIds: [], path: '/action', body: '{}' }
        const id = '10000000-0000-4000-8000-000000000001'
        const result = queue.queueMutation(input, id).catch(error => error.message)
        const stale = values.get(key)!
        online = true
        queue.configureMutationReplay(async () => 'saved')
        await queue.replayMutations()
        await result
        values.set(key, stale)
        session.setSessionOwner('other')
        session.setSessionOwner('account')
        const sender = vi.fn(async () => 'duplicate')
        queue.configureMutationReplay(sender)
        await queue.replayMutations()
        expect(queue.pendingMutations()).toEqual([])
        await expect(queue.queueMutation(input, id)).rejects.toThrow('earlier session')
        expect(sender).not.toHaveBeenCalled()
    })

    it('retains a rejection omitted by a stale tab write until explicit retry', async () => {
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const queue = await import('@/lib/cache/mutation-queue')
        vi.resetModules()
        const secondSession = await import('@/lib/session-cache-registry')
        secondSession.setSessionOwner('account')
        const secondTab = await import('@/lib/cache/mutation-queue')
        secondTab.mutationSnapshot()
        const input = { accountId: 'account', leagueId: null, rowIds: [], path: '/a', body: '{}' }
        const id = '10000000-0000-4000-8000-000000000001'
        const result = queue.queueMutation(input, id).catch(error => error.message)
        void secondTab.queueMutation({ ...input, path: '/b' }, '10000000-0000-4000-8000-000000000002')
        expect(JSON.parse(values.get(key)!).map((job: { path: string }) => job.path)).toEqual(['/b'])
        vi.spyOn(storage, 'setItem').mockImplementationOnce(() => { throw new Error('Disk full') })
        online = true
        queue.configureMutationReplay(async () => { throw new Error('Server rejected') })
        await queue.replayMutations()
        await expect(result).resolves.toBe('Server rejected')
        online = false
        session.setSessionOwner('other')
        session.setSessionOwner('account')
        expect(queue.pendingMutations().map(job => `${job.path}:${job.status}`)).toEqual(['/b:pending', '/a:failed'])
        queue.retryMutation(id)
        expect(queue.pendingMutations().find(job => job.id === id)?.status).toBe('pending')
    })

    it('does not restore an unsaved rejection after another tab completes its job', async () => {
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const queue = await import('@/lib/cache/mutation-queue')
        const input = { accountId: 'account', leagueId: null, rowIds: [], path: '/action', body: '{}' }
        queue.configureMutationReplay(async () => { throw new Error('Server rejected') })
        const result = queue.queueMutation(input).catch(error => error.message)
        vi.spyOn(storage, 'setItem').mockImplementationOnce(() => { throw new Error('Disk full') })
        online = true
        await queue.replayMutations()
        await expect(result).resolves.toBe('Server rejected')
        expect(queue.pendingMutations()[0].status).toBe('failed')
        expect(JSON.parse(values.get(key)!)[0].status).toBe('pending')
        vi.resetModules()
        const secondSession = await import('@/lib/session-cache-registry')
        secondSession.setSessionOwner('account')
        const secondTab = await import('@/lib/cache/mutation-queue')
        const completed = vi.fn(async () => 'saved')
        secondTab.configureMutationReplay(completed)
        await secondTab.replayMutations()
        expect(completed).toHaveBeenCalledOnce()
        expect(JSON.parse(values.get(key) ?? '[]')).toEqual([])
        session.setSessionOwner('other')
        session.setSessionOwner('account')
        const restored = queue.pendingMutations()
        const sender = vi.fn(async (_job: { path: string }) => 'saved')
        queue.configureMutationReplay(sender)
        await queue.replayMutations()
        let saved: unknown
        void queue.queueMutation({ ...input, path: '/next' }).then(value => { saved = value })
        await queue.replayMutations()
        expect(restored).toEqual([])
        expect(sender).toHaveBeenCalledOnce()
        expect(sender.mock.calls[0][0].path).toBe('/next')
        expect(saved).toBe('saved')
        expect(queue.pendingMutations()).toEqual([])
    })

    it.each(['unavailable', 'malformed', 'non-array'] as const)('keeps an unsaved rejection when the next disk read is %s', async fault => {
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const queue = await import('@/lib/cache/mutation-queue')
        const sender = vi.fn(async () => { throw new Error('Server rejected') })
        queue.configureMutationReplay(sender)
        const result = queue.queueMutation({ accountId: 'account', leagueId: null, rowIds: [], path: '/action', body: '{}' }).catch(error => error.message)
        vi.spyOn(storage, 'setItem').mockImplementationOnce(() => { throw new Error('Disk full') })
        online = true
        await queue.replayMutations()
        await expect(result).resolves.toBe('Server rejected')
        if (fault === 'unavailable') vi.spyOn(storage, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable') })
        else values.set(key, fault === 'malformed' ? '{invalid' : 'null')
        session.setSessionOwner('other')
        session.setSessionOwner('account')
        await queue.replayMutations()
        expect(sender).toHaveBeenCalledOnce()
        expect(queue.pendingMutations()[0]).toMatchObject({ status: 'failed', error: 'Server rejected' })
    })

    it('retains an unsaved rejection across account changes until explicit retry', async () => {
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const queue = await import('@/lib/cache/mutation-queue')
        const sender = vi.fn().mockRejectedValueOnce(new Error('Server rejected')).mockResolvedValue('saved')
        queue.configureMutationReplay(sender)
        const input = { accountId: 'account', leagueId: null, rowIds: [], path: '/action', body: '{}' }
        const result = queue.queueMutation(input).catch(error => error.message)
        const id = queue.pendingMutations()[0].id
        const save = vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('Disk full') })
        online = true
        await queue.replayMutations()
        await expect(result).resolves.toBe('Server rejected')
        expect(queue.pendingMutations()[0]).toMatchObject({ id, status: 'failed', error: 'Server rejected' })
        expect(JSON.parse(values.get(key)!)[0].status).toBe('pending')
        save.mockRestore()
        session.setSessionOwner('other')
        session.setSessionOwner('account')
        await queue.replayMutations()
        expect(sender).toHaveBeenCalledOnce()
        expect(queue.pendingMutations()[0]).toMatchObject({ id, status: 'failed', error: 'Server rejected' })
        const next = queue.queueMutation({ ...input, path: '/next' })
        expect(JSON.parse(values.get(key)!)[0]).toMatchObject({ id, status: 'failed', error: 'Server rejected' })
        session.setSessionOwner('other')
        const changed = expect(next).rejects.toThrow('account changed')
        session.setSessionOwner('account')
        await changed
        await queue.replayMutations()
        expect(sender).toHaveBeenCalledOnce()
        queue.retryMutation(id)
        await queue.replayMutations()
        expect(sender).toHaveBeenCalledTimes(3)
        expect(queue.pendingMutations()).toEqual([])
    })


    it('reloads another tab’s completed action on account switch without restoring it', async () => {
        const firstSession = await import('@/lib/session-cache-registry')
        firstSession.setSessionOwner('account')
        const firstTab = await import('@/lib/cache/mutation-queue')
        const input = { accountId: 'account', leagueId: null, rowIds: [], path: '/action', body: '{}' }
        const result = firstTab.queueMutation(input)
        vi.resetModules()
        const secondSession = await import('@/lib/session-cache-registry')
        secondSession.setSessionOwner('account')
        const secondTab = await import('@/lib/cache/mutation-queue')
        expect(secondTab.pendingMutations()).toHaveLength(1)
        firstTab.configureMutationReplay(async () => 'saved')
        online = true
        await firstTab.replayMutations()
        await expect(result).resolves.toBe('saved')
        secondSession.setSessionOwner('other')
        secondSession.setSessionOwner('account')
        const sender = vi.fn(async () => 'saved')
        secondTab.configureMutationReplay(sender)
        await secondTab.replayMutations()
        expect(sender).not.toHaveBeenCalled()
        expect(secondTab.pendingMutations()).toEqual([])
    })

    it('leaves a connection-loss failure pending and replays on the online event', async () => {
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const queue = await import('@/lib/cache/mutation-queue')
        let reject!: (error: Error) => void
        const sender = vi.fn().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail })).mockResolvedValue('saved')
        queue.configureMutationReplay(sender)
        let result = 'pending'
        void queue.queueMutation({ accountId: 'account', leagueId: null, rowIds: [], path: '/action', body: '{}' }).then(value => { result = String(value) }, error => { result = error.message })
        online = true
        const replay = queue.replayMutations()
        online = false
        reject(new TypeError('Failed to fetch'))
        await replay
        expect(result).toBe('pending')
        expect(queue.pendingMutations()[0]).toMatchObject({ status: 'pending', error: null })
        online = true
        window.dispatchEvent(new Event('online'))
        await queue.replayMutations()
        expect(sender).toHaveBeenCalledTimes(2)
        expect(result).toBe('saved')
        expect(queue.pendingMutations()).toEqual([])
    })

    it('replaces malformed saved JSON when enqueueing', async () => {
        values.set(key, '{invalid')
        const session = await import('@/lib/session-cache-registry')
        session.setSessionOwner('account')
        const queue = await import('@/lib/cache/mutation-queue')
        let error: unknown
        void queue.queueMutation({ accountId: 'account', leagueId: null, rowIds: [], path: '/action', body: '{}' }).catch(cause => { error = cause })
        await Promise.resolve()
        expect(error).toBeUndefined()
        expect(queue.pendingMutations()).toHaveLength(1)
        expect(JSON.parse(values.get(key)!)).toEqual(queue.pendingMutations())
    })

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
