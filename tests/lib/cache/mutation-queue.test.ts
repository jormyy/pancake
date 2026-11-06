import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const identity = vi.hoisted(() => ({ owner: 'account', generation: 0, clears: [] as (() => void)[] }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionOwner: () => identity.owner, sessionGeneration: () => identity.generation, onSessionCachesCleared: (callback: () => void) => identity.clears.push(callback) }))
const values = new Map<string, string>()
let online = false
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }
const input = { accountId: 'account', leagueId: 'league', rowIds: ['player'], path: '/waivers/claims', body: JSON.stringify({ playerId: 'player', bidAmount: 12 }) }
beforeEach(() => {
    vi.resetModules(); values.clear(); identity.owner = 'account'; identity.generation = 0; identity.clears = []; online = false
    vi.stubGlobal('navigator', { get onLine() { return online } }); vi.stubGlobal('window', { localStorage: storage, addEventListener: vi.fn() })
})
afterEach(() => { vi.restoreAllMocks() })
describe('durable ordered mutation replay', () => {
    it.each([
        ['storage', 'sent'], ['storage', 'failed'], ['subscriber', 'sent'], ['subscriber', 'failed'],
    ] as const)('settles a %s fault after the sender is %s without losing its result', async (fault, outcome) => {
        const report = vi.spyOn(console, 'error').mockImplementation(() => {})
        const queue = await import('@/lib/cache/mutation-queue')
        const failure = new Error('Server rejected the action')
        const sender = vi.fn().mockImplementation(async () => {
            if (outcome === 'failed') throw failure
            return 'saved'
        })
        queue.configureMutationReplay(sender)
        let settled: unknown = 'pending'
        void queue.queueMutation(input).then(value => { settled = value }, error => { settled = error.message })
        if (fault === 'storage') vi.spyOn(storage, 'setItem').mockImplementationOnce(() => { throw new Error('Disk full') })
        const changed = vi.fn()
        if (fault === 'subscriber') queue.subscribeMutations(() => { throw new Error('Broken subscriber') })
        queue.subscribeMutations(changed)
        online = true
        await queue.replayMutations().catch(() => {})
        await Promise.resolve()
        expect(settled).toBe(outcome === 'sent' ? 'saved' : failure.message)
        expect(sender).toHaveBeenCalledOnce()
        expect(changed).toHaveBeenCalledOnce()
        expect(report).toHaveBeenCalledOnce()
        if (outcome === 'sent') expect(queue.pendingMutations()).toEqual([])
        else expect(queue.pendingMutations()[0]).toMatchObject({ status: 'failed', error: failure.message })
    })

    it.each(['resolve', 'reject'] as const)('starts the next account replay before the old send can %s', async outcome => {
        const queue = await import('@/lib/cache/mutation-queue')
        let finishOld!: (value: string) => void
        let failOld!: (error: Error) => void
        const sender = vi.fn().mockReturnValueOnce(new Promise<string>((resolve, reject) => { finishOld = resolve; failOld = reject })).mockResolvedValue('new account saved')
        queue.configureMutationReplay(sender)
        const oldResult = queue.queueMutation(input)
        const oldRejection = expect(oldResult).rejects.toThrow('account changed')
        online = true
        const oldReplay = queue.replayMutations()
        identity.owner = 'other'
        identity.generation += 1
        for (const clear of identity.clears) clear()
        let nextResult: unknown
        void queue.queueMutation({ ...input, accountId: 'other' }).then(value => { nextResult = value })
        const nextReplay = queue.replayMutations()
        await Promise.resolve()
        const sendsBeforeOldCompletion = sender.mock.calls.length
        if (outcome === 'resolve') finishOld('old account saved')
        else failOld(new Error('Old send failed'))
        await Promise.all([oldReplay, nextReplay, oldRejection])
        expect(sendsBeforeOldCompletion).toBe(2)
        expect(sender.mock.calls.map(([job]) => job.accountId)).toEqual(['account', 'other'])
        expect(nextResult).toBe('new account saved')
        expect(queue.pendingMutations()).toEqual([])
        expect(queue.pendingMutations('account')).toHaveLength(1)
    })

    it('ignores retry while a pending action is already being sent', async () => {
        const queue = await import('@/lib/cache/mutation-queue')
        let finish!: (value: string) => void
        const sender = vi.fn().mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve })).mockResolvedValue('saved')
        queue.configureMutationReplay(sender)
        const result = queue.queueMutation(input)
        const id = queue.pendingMutations()[0].id
        online = true
        const replay = queue.replayMutations()
        expect(sender).toHaveBeenCalledOnce()
        queue.retryMutation(id)
        finish('saved')
        await replay
        await expect(result).resolves.toBe('saved')
        expect(sender).toHaveBeenCalledOnce()
        expect(queue.pendingMutations()).toEqual([])
    })

    it('settles every caller that queues the same request ID', async () => {
        const queue = await import('@/lib/cache/mutation-queue')
        const sender = vi.fn(async () => 'saved')
        queue.configureMutationReplay(sender)
        let firstResult: unknown
        let secondResult: unknown
        void queue.queueMutation(input, '10000000-0000-4000-8000-000000000001').then(value => { firstResult = value })
        void queue.queueMutation(input, '10000000-0000-4000-8000-000000000001').then(value => { secondResult = value })
        online = true
        await queue.replayMutations()
        expect(sender).toHaveBeenCalledOnce()
        expect(firstResult).toBe('saved')
        expect(secondResult).toBe('saved')
        expect(queue.pendingMutations()).toEqual([])
    })

    it('saves input and row badges offline, then sends each request once in order', async () => {
        const queue = await import('@/lib/cache/mutation-queue')
        const sender = vi.fn(async job => job.body)
        queue.configureMutationReplay(sender)
        const empty = queue.mutationSnapshot()
        expect(queue.mutationSnapshot()).toBe(empty)
        const first = queue.queueMutation(input)
        const queued = queue.mutationSnapshot()
        expect(queued).not.toBe(empty)
        expect(empty).toEqual([])
        const second = queue.queueMutation({ ...input, rowIds: ['second'], body: '{"bidAmount":15}' })
        expect(sender).not.toHaveBeenCalled()
        expect(queue.pendingMutations().map(job => job.rowIds[0])).toEqual(['player', 'second'])
        expect(values.values().next().value).toContain('bidAmount')
        online = true
        await Promise.all([queue.replayMutations(), queue.replayMutations(), first, second])
        expect(sender.mock.calls.map(([job]) => job.rowIds[0])).toEqual(['player', 'second'])
        expect(queue.pendingMutations()).toEqual([])
        expect(queued).toHaveLength(1)
        expect(queue.mutationSnapshot()).not.toBe(queued)
    })
    it('retains failed input and blocks later actions until retry uses the same request ID', async () => {
        const queue = await import('@/lib/cache/mutation-queue')
        const sender = vi.fn().mockRejectedValueOnce(new Error('Response lost')).mockResolvedValue('saved')
        queue.configureMutationReplay(sender)
        const first = queue.queueMutation(input)
        const rejection = expect(first).rejects.toThrow('Response lost')
        const second = queue.queueMutation({ ...input, rowIds: ['second'] })
        const id = queue.pendingMutations()[0].id
        online = true; await queue.replayMutations(); await rejection
        expect(sender).toHaveBeenCalledTimes(1)
        expect(queue.pendingMutations()[0]).toMatchObject({ id, body: input.body, status: 'failed', error: 'Response lost' })
        queue.retryMutation(id); await queue.replayMutations(); await second
        expect(sender.mock.calls.map(([job]) => job.id)).toEqual([id, id, expect.any(String)])
        expect(queue.pendingMutations()).toEqual([])
    })
    it('restores pending input after a reload without saving auth tokens', async () => {
        const first = await import('@/lib/cache/mutation-queue')
        void first.queueMutation(input)
        const id = first.pendingMutations()[0].id
        vi.resetModules()
        const restored = await import('@/lib/cache/mutation-queue')
        expect(restored.pendingMutations()[0]).toMatchObject({ id, body: input.body, status: 'pending' })
        expect([...values.values()].join('')).not.toMatch(/access_token|Authorization/)
        online = true
        const sender = vi.fn(async (_job: { id: string }) => 'saved')
        restored.configureMutationReplay(sender); await restored.replayMutations()
        expect(sender).toHaveBeenCalledTimes(1)
        expect(sender.mock.calls[0]?.[0]).toMatchObject({ id })
    })
    it('never replays another account’s saved actions', async () => {
        const queue = await import('@/lib/cache/mutation-queue')
        void queue.queueMutation(input)
        identity.owner = 'other'; identity.generation += 1; online = true
        const sender = vi.fn(async (_job: { id: string }) => 'saved')
        queue.configureMutationReplay(sender); await queue.replayMutations()
        expect(sender).not.toHaveBeenCalled(); expect(queue.pendingMutations()).toEqual([])
    })
    it('rejects another account before queueing', async () => {
        const queue = await import('@/lib/cache/mutation-queue')
        await expect(queue.queueMutation({ ...input, accountId: 'other' })).rejects.toThrow('account changed')
        expect(queue.pendingMutations()).toEqual([])
    })
})
