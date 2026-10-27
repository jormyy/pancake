import { beforeEach, describe, expect, it, vi } from 'vitest'
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
describe('durable ordered mutation replay', () => {
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
