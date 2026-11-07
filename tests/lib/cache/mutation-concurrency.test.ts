import { expect, it } from 'vitest'
import { runCompletionRace } from '../../helpers/mutation-completion-race'
import type { QueuedMutation } from '@/lib/cache/mutation-queue'

it('retains independent completion records when two tabs finish together', async () => {
    const records: QueuedMutation[] = ['A', 'B'].map((accountId, index) => ({
        id: `10000000-0000-4000-8000-00000000000${index + 1}`, accountId, leagueId: null,
        rowIds: [], path: '/action', body: '{}', status: 'pending', error: null, createdAt: 0,
    }))
    const result = await runCompletionRace(records)
    console.log(JSON.stringify(result))
    expect(result.retained).toHaveLength(2)
    expect(result.duplicates).toBe(0)
})

it('preserves a completion written after cleanup captures its clock', async () => {
    const { cleanupRace } = await import('../../helpers/mutation-storage-race')
    expect(cleanupRace()).toEqual({ retained: ['A', 'B'], sends: ['A', 'B'] })
})

it.each(['initial check', 'persist read', 'persist write'] as const)('settles completion during enqueue at %s without retaining a waiter', async boundary => {
    const { enqueueRace } = await import('../../helpers/mutation-storage-race')
    expect(enqueueRace(boundary)).toEqual({
        first: 'saved', second: 'This action completed in another tab. Refresh to see the result.', pending: 0,
        sends: ['A'], retry: 'This action belongs to an earlier session. Refresh before retrying.',
    })
})

it('keeps completion proof refreshed between cleanup read and deletion', async () => {
    const { storageRace, records, completionPrefix, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(records)
    const a = race.tab('A')
    const marker = completionPrefix + 'B:' + records[1].id
    race.values.set(marker, '1')
    race.onSet = key => {
        if (key !== completionPrefix + 'A:' + records[0].id) return
        race.onGet = name => {
            if (name !== marker) return
            race.onGet = undefined
            race.values.set(marker, String(race.now))
        }
    }
    race.run(a, start)
    expect(race.values.has(marker)).toBe(true)
})

it('keeps caller settlement when completion is readable only during enqueue persistence', async () => {
    const { storageRace, records, completionPrefix, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace()
    const first = race.tab('A'), second = race.tab('A')
    race.run(first, enqueue)
    race.onGet = name => {
        if (name !== completionPrefix + 'A:' + records[0].id) return
        race.onGet = undefined
        race.run(first, start)
        race.onGet = key => {
            if (key === name) race.onGet = () => { throw new Error('Storage unavailable after observing completion') }
        }
    }
    race.run(second, enqueue)
    expect(second.result).toBe('This action completed in another tab. Refresh to see the result.')
})

it('checks the selected job again after another completion arrives while scanning the queue', async () => {
    const { storageRace, records, completionPrefix, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(records)
    const first = race.tab('A'), second = race.tab('A')
    race.run(second, enqueue)
    race.onGet = key => {
        if (key !== completionPrefix + 'B:' + records[1].id) return
        race.onGet = undefined
        race.run(first, start)
    }
    race.run(second, start)
    expect(race.sends).toEqual(['A'])
    expect(second.result).toBe('This action completed in another tab. Refresh to see the result.')
})

it('does not forget a pre-send completion when the next storage read fails', async () => {
    const { storageRace, records, completionPrefix, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(records)
    const first = race.tab('A'), second = race.tab('A')
    race.run(second, enqueue)
    race.onGet = key => {
        if (key !== completionPrefix + 'B:' + records[1].id) return
        race.onGet = undefined
        race.run(first, start)
        race.onGet = name => {
            if (name.startsWith(completionPrefix)) race.onGet = () => { throw new Error('Storage unavailable') }
        }
    }
    race.run(second, start)
    expect(race.sends).toEqual(['A'])
    expect(second.result).toBe('This action completed in another tab. Refresh to see the result.')
    expect(race.run(second, 'queue.pendingMutations().length')).toBe(0)
})

it('keeps completion proof when a failed retry write restores an older snapshot', async () => {
    const { storageRace, records, completionPrefix, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(records.map(job => ({ ...job, status: 'failed', error: 'Rejected' })))
    const first = race.tab('A'), second = race.tab('A')
    let reads = 0
    race.onGet = key => {
        if (key !== completionPrefix + 'A:' + records[0].id || ++reads !== 2) return
        race.onGet = undefined
        race.run(first, 'queue.retryMutation(input.id);' + start)
        race.onSet = name => {
            if (name !== 'pancake:offline-mutations:v1') return
            race.onGet = () => { throw new Error('Storage unavailable') }
            race.onSet = undefined
            throw new Error('Disk full')
        }
    }
    race.run(second, 'try {queue.retryMutation(input.id)} catch {}')
    race.run(second, start)
    race.run(second, 'queue.retryMutation(input.id)')
    expect(race.sends).toEqual(['A'])
    expect(race.run(second, 'queue.pendingMutations().length')).toBe(0)
})

it('publishes completion proof before another tab observes the empty queue', async () => {
    const { storageRace, records, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([records[0]])
    const first = race.tab('A'), stale = race.tab('A')
    race.onSet = key => {
        if (key !== 'pancake:offline-mutations:v1') return
        race.onSet = undefined
        race.run(stale, start)
    }
    race.run(first, start)
    expect(race.sends).toEqual(['A'])
})

it('settles completion observed by the first queue read when later reads fail', async () => {
    const { storageRace, records, completionPrefix, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(records)
    const first = race.tab('A'), second = race.tab('A')
    const marker = completionPrefix + 'A:' + records[0].id
    race.onGet = name => {
        if (name !== marker) return
        race.onGet = undefined
        race.run(first, start)
        race.onGet = (key, value) => {
            if (key === marker && value) race.onGet = () => { throw new Error('Storage unavailable after observing completion') }
        }
    }
    race.run(second, enqueue)
    race.onGet = undefined
    race.run(second, start)
    expect(second.result).toBe('This action completed in another tab. Refresh to see the result.')
    race.run(second, 'queue.queueMutation(input,input.id).then(v=>retry=v,e=>retry=e.message)')
    expect(second.retry).toBe('This action belongs to an earlier session. Refresh before retrying.')
    expect(race.run(second, 'queue.pendingMutations().length')).toBe(0)
    expect(race.sends).toEqual(['A'])
})

it('keeps observed completion after saving unrelated work while marker reads fail', async () => {
    const { storageRace, records, completionPrefix, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(records)
    const first = race.tab('A'), second = race.tab('A')
    race.run(second, enqueue)
    race.run(first, start)
    race.run(second, 'queue.pendingMutations()')
    race.run(second, 'queue.queueMutation(input,"10000000-0000-4000-8000-000000000003").catch(()=>{})')
    race.onGet = name => {
        if (name === completionPrefix + 'A:' + records[0].id) throw new Error('Storage unavailable')
    }
    race.run(second, 'queue.queueMutation(input,input.id).then(v=>retry=v,e=>retry=e.message)')
    expect(second.retry).toBe('This action belongs to an earlier session. Refresh before retrying.')
})

it('preserves another tab’s saved action when completion publishes an older queue', async () => {
    const { storageRace, records, completionPrefix, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([records[0]])
    const first = race.tab('A'), second = race.tab('A')
    race.run(first, 'queue.configureMutationReplay(async()=>{record();navigator.onLine=false})')
    second.input = { ...records[1], accountId: 'A', path: '/second' }
    race.run(second, enqueue)
    race.run(first, start)
    const restored = race.tab('A')
    expect(race.run(restored, 'queue.pendingMutations().map(job=>job.path)')).toEqual(['/second'])
    expect(race.values.has(completionPrefix + 'A:' + records[1].id)).toBe(false)
    expect(race.sends).toEqual(['A'])
})

it('restores an action enqueued between a snapshot read and its stale write', async () => {
    const { storageRace, records, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([records[0]])
    const first = race.tab('A'), second = race.tab('A')
    race.run(first, 'queue.configureMutationReplay(async()=>{record();navigator.onLine=false})')
    second.input = { ...records[1], accountId: 'A', path: '/second' }
    race.onBeforeSet = (key, value) => {
        if (key !== 'pancake:offline-mutations:v1') return
        if (JSON.parse(value).some((job: { id: string }) => job.id === records[0].id)) return
        race.onBeforeSet = undefined
        race.run(second, enqueue)
    }
    race.run(first, start)
    expect(race.values.get('pancake:offline-mutations:v1')).toBe('[]')
    const restored = race.tab('A')
    expect(race.run(restored, 'queue.pendingMutations().map(job=>job.path)')).toEqual(['/second'])
    expect(race.sends).toEqual(['A'])
})

it('keeps a durably saved action when only the shared snapshot write fails', async () => {
    const { storageRace, enqueue } = await import('../../helpers/mutation-storage-race')
    const race = storageRace()
    const first = race.tab('A')
    race.onBeforeSet = key => { if (key === 'pancake:offline-mutations:v1') throw new Error('Snapshot write failed') }
    race.run(first, enqueue)
    expect(first.result).toBe('pending')
    const restored = race.tab('A')
    expect(race.run(restored, 'queue.pendingMutations().length')).toBe(1)
})

it('blocks a stale tab after another tab saves a rejection until explicit retry', async () => {
    const { storageRace, records, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([records[0]])
    const first = race.tab('A'), second = race.tab('A')
    race.run(first, 'queue.configureMutationReplay(async()=>{record();throw new Error("Rejected")})')
    race.run(second, enqueue)
    race.run(first, start)
    race.run(second, start)
    expect(race.sends).toEqual(['A'])
    expect(second.result).toBe('Rejected')
    expect(race.run(second, 'queue.pendingMutations()[0].status')).toBe('failed')
    race.run(second, 'queue.retryMutation(input.id)')
    expect(race.sends).toEqual(['A', 'A'])
    expect(race.run(second, 'queue.pendingMutations().length')).toBe(0)
})

it('keeps a rejection that arrives just before stale enqueue writes its copy', async () => {
    const { storageRace, records, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([records[0]])
    const first = race.tab('A'), stale = race.tab('A')
    race.run(first, 'queue.configureMutationReplay(async()=>{record();throw new Error("Rejected")})')
    race.onBeforeSet = key => {
        if (key !== 'pancake:offline-mutation:v1:A:' + records[0].id) return
        race.onBeforeSet = undefined
        race.run(first, start)
    }
    race.run(stale, enqueue + ';' + start)
    expect(race.sends).toEqual(['A'])
    expect(stale.result).toBe('Rejected')
    expect(race.run(stale, 'queue.pendingMutations()[0].status')).toBe('failed')
})

it('keeps a failed retry blocked after a later import write fails', async () => {
    const { storageRace, records, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([{ ...records[0], status: 'failed', error: 'Rejected' }, records[1]])
    const first = race.tab('A')
    race.onBeforeSet = key => { if (key === 'pancake:offline-mutation:v1:B:' + records[1].id) throw new Error('QuotaExceededError') }
    race.run(first, 'try{queue.retryMutation(input.id)}catch(error){result=error.message}')
    expect(first.result).toBe('Could not save your pending action. Keep this screen open and retry.')
    expect(race.run(first, 'queue.pendingMutations()[0].status')).toBe('failed')
    race.onBeforeSet = undefined
    const restored = race.tab('A')
    race.run(restored, start)
    expect(race.sends).toEqual([])
    expect(race.run(restored, 'queue.pendingMutations()[0].status')).toBe('failed')
})

it('saves every imported legacy action before sending or overwriting its old list', async () => {
    const { storageRace, records, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace()
    const stale = race.tab('A')
    const legacy = records.map(job => ({ ...job, accountId: 'A' }))
    race.values.set('pancake:offline-mutations:v1', JSON.stringify(legacy))
    const first = race.tab('A')
    race.run(first, 'queue.configureMutationReplay(()=>{record();return new Promise(()=>{})})')
    race.run(first, start)
    stale.input = { ...records[0], id: '10000000-0000-4000-8000-000000000003', path: '/unrelated' }
    race.run(stale, enqueue)
    const restored = race.tab('A')
    expect(race.run(restored, 'queue.pendingMutations().map(job=>job.id)')).toEqual([...legacy.map(job => job.id), stale.input.id])
    expect(race.values.has('pancake:offline-mutation:v1:A:' + records[1].id)).toBe(true)
    expect(race.sends).toEqual(['A'])
})

it('waits for all legacy imports to save before starting a send', async () => {
    const { storageRace, records, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(records.map(job => ({ ...job, accountId: 'A' })))
    const first = race.tab('A')
    race.onBeforeSet = key => { if (key === 'pancake:offline-mutation:v1:A:' + records[1].id) throw new Error('QuotaExceededError') }
    race.run(first, start)
    expect(race.sends).toEqual([])
    const restored = race.tab('A')
    expect(race.run(restored, 'queue.pendingMutations().length')).toBe(2)
    expect(race.run(first, 'queue.pendingMutations()[0].status')).toBe('failed')
    race.onBeforeSet = undefined
    race.run(first, 'queue.retryMutation(input.id);' + start)
    expect(race.sends).toEqual(['A', 'A'])
    expect(race.run(first, 'queue.pendingMutations().length')).toBe(0)
})

it('does not let a stale retry acknowledge a newer rejection', async () => {
    const { storageRace, records, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([{ ...records[0], status: 'failed', error: 'Original rejection' }])
    const first = race.tab('A'), second = race.tab('A')
    race.run(second, 'queue.configureMutationReplay(async()=>{record();throw new Error("New rejection")})')
    race.onBeforeSet = key => {
        if (!key.startsWith('pancake:offline-mutation-retry:v1:')) return
        race.onBeforeSet = undefined
        race.run(second, 'queue.retryMutation(input.id);' + start)
    }
    race.run(first, 'queue.retryMutation(input.id);' + start)
    expect(race.sends).toEqual(['A'])
    expect(race.run(first, 'queue.pendingMutations()[0].error')).toBe('New rejection')
    expect(race.run(first, 'queue.pendingMutations()[0].status')).toBe('failed')
})

it('preserves unreadable legacy input and restores its order before newer input', async () => {
    const { storageRace, records, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([records[0]])
    race.onGet = key => { if (key === 'pancake:offline-mutations:v1') throw new Error('Read unavailable') }
    const first = race.tab('A')
    first.input = { ...records[1], accountId: 'A', path: '/new' }
    race.run(first, enqueue + ';' + start)
    expect(race.sends).toEqual([])
    expect(first.result).toBe('Could not read your pending actions. Refresh and retry.')
    race.onGet = undefined
    const restored = race.tab('A')
    expect(race.run(restored, 'queue.pendingMutations().map(job=>job.path)')).toEqual(['/action', '/new'])
    race.run(first, 'paths=[];queue.configureMutationReplay(async job=>{paths.push(job.path);return "saved"});' + start)
    race.run(first, 'queue.retryMutation(input.id)')
    expect(Array.from(first.paths)).toEqual(['/action', '/new'])
})

it('retains saved retry intent when an input read fails over a stale failed cache', async () => {
    const { storageRace, records, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace()
    const first = race.tab('A')
    race.run(first, enqueue + ';queue.configureMutationReplay(async()=>{record();throw new Error("Rejected")});' + start)
    race.run(first, 'navigator.onLine=false')
    race.onBeforeSet = key => { if (key === 'pancake:offline-mutations:v1') throw new Error('Cache write unavailable') }
    race.run(first, 'queue.retryMutation(input.id)')
    race.onBeforeSet = undefined
    let once = true
    race.onGet = key => { if (once && key === 'pancake:offline-mutation:v1:A:' + records[0].id) { once = false; throw new Error('Read unavailable') } }
    race.run(first, 'queue.pendingMutations()')
    race.onGet = undefined
    expect(race.run(first, 'queue.pendingMutations()[0].status')).toBe('pending')
    race.run(first, start)
    expect(race.sends).toEqual(['A', 'A'])
})

it('makes progress when an imported input record cannot be read back', async () => {
    const { runInContext } = await import('node:vm')
    const { storageRace, records, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([records[0]])
    const first = race.tab('A')
    let writes = 0
    race.onSet = () => { writes++ }
    race.onGet = key => { if (key === 'pancake:offline-mutation:v1:A:' + records[0].id) throw new Error('Read unavailable') }
    expect(() => runInContext(start, first, { timeout: 200 })).not.toThrow()
    expect(writes).toBeLessThan(20)
    expect(race.sends).toEqual([])
    race.onGet = undefined
    expect(race.run(first, 'queue.pendingMutations()[0].error')).toBe('Could not read your pending actions. Refresh and retry.')
    race.run(first, 'queue.retryMutation(input.id);' + start)
    expect(race.sends).toEqual(['A'])
})

it('keeps saved retry intent when enumeration is unavailable', async () => {
    const { storageRace, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace()
    const first = race.tab('A')
    race.run(first, enqueue + ';queue.configureMutationReplay(async()=>{record();throw new Error("Rejected")});' + start)
    race.run(first, 'navigator.onLine=false')
    race.onBeforeSet = key => { if (key === 'pancake:offline-mutations:v1') throw new Error('Cache write unavailable') }
    race.run(first, 'queue.retryMutation(input.id)')
    race.onBeforeSet = undefined
    race.onEnumerate = () => { throw new Error('Enumeration unavailable') }
    expect(race.run(first, 'queue.pendingMutations()[0].status')).toBe('pending')
    race.run(first, start)
    expect(race.sends).toEqual(['A'])
    expect(race.run(first, 'queue.pendingMutations()[0].error')).toBe('Could not read your pending actions. Refresh and retry.')
    race.onEnumerate = undefined
    race.run(first, 'queue.retryMutation(input.id);' + start)
    expect(race.sends).toEqual(['A', 'A'])
})

it('rejects an unsaved caller safely when access to storage itself is denied', async () => {
    const { storageRace, enqueue } = await import('../../helpers/mutation-storage-race')
    const race = storageRace()
    const first = race.tab('A')
    Object.defineProperty(first.window, 'localStorage', { get() { throw new Error('Access denied') } })
    expect(() => race.run(first, 'queue.mutationSnapshot()')).not.toThrow()
    expect(() => race.run(first, enqueue)).not.toThrow()
    expect(first.result).toBe('Could not save your pending action. Keep this screen open and retry.')
})

it('replays in memory without a browser instead of waiting for nonexistent storage', async () => {
    const { runInContext } = await import('node:vm')
    const { storageRace, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace()
    const first = race.tab('A')
    race.run(first, 'delete globalThis.window')
    expect(() => runInContext(enqueue + ';' + start, first, { timeout: 200 })).not.toThrow()
    expect(first.result).toBe('saved')
    expect(race.sends).toEqual(['A'])
})

it('retains a saved rejection when another completion removes an earlier storage key', async () => {
    const { storageRace, records, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([records[1], records[0]])
    const first = race.tab('A')
    race.run(first, enqueue)
    const other = race.tab('B'), stale = race.tab('A')
    race.run(stale, enqueue)
    race.run(first, 'queue.configureMutationReplay(async()=>{record();throw new Error("Rejected")});' + start)
    race.onGet = key => {
        if (key !== 'pancake:offline-mutation:v1:A:' + records[0].id) return
        race.onGet = undefined
        race.run(other, start)
    }
    race.run(stale, start)
    expect(race.sends).toEqual(['A', 'B'])
    expect(stale.result).toBe('Rejected')
    expect([...race.values.keys()].filter(key => key.startsWith('pancake:offline-mutation-retry:v1:'))).toEqual([])
})

it('resumes an online caller after a transient read failure without another replay event', async () => {
    const { storageRace, records, enqueue } = await import('../../helpers/mutation-storage-race')
    const race = storageRace()
    const first = race.tab('A')
    race.run(first, 'navigator.onLine=true')
    let reads = 0
    race.onGet = key => { if (key === 'pancake:offline-mutation:v1:A:' + records[0].id && ++reads === 3) throw new Error('Transient read failure') }
    race.run(first, enqueue)
    race.onGet = undefined
    race.run(first, 'void 0')
    expect(first.result).toBe('saved')
    expect(race.sends).toEqual(['A'])
    expect(race.run(first, 'queue.pendingMutations().length')).toBe(0)
})

it.each(['browser', 'memory'] as const)('settles rejection and explicit retry without crypto in %s mode', async mode => {
    const { storageRace, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace()
    const first = race.tab('A')
    race.run(first, 'delete globalThis.crypto' + (mode === 'memory' ? ';delete globalThis.window' : ''))
    race.run(first, enqueue + ';queue.configureMutationReplay(async()=>{record();throw new Error("Rejected")});' + start)
    expect(first.result).toBe('Rejected')
    expect(race.run(first, 'queue.pendingMutations()[0].status')).toBe('failed')
    race.run(first, 'queue.configureMutationReplay(async()=>{record();return "saved"});queue.retryMutation(input.id)')
    expect(race.sends).toEqual(['A', 'A'])
    expect(race.run(first, 'queue.pendingMutations().length')).toBe(0)
})

it('starts an accepted retry queued while a completed replay guard is clearing', async () => {
    const { storageRace, records } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([{ ...records[0], status: 'failed', error: 'Rejected' }])
    const first = race.tab('A')
    race.run(first, 'navigator.onLine=true;queue.configureMutationReplay(async()=>{record();return "saved"});queue.retryMutation(input.id)')
    expect(race.sends).toEqual(['A'])
    expect(race.run(first, 'queue.pendingMutations().length')).toBe(0)
})
