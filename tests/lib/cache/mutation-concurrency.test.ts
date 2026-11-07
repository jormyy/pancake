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
        race.onGet = (name, value) => {
            if (name === completionPrefix + 'A:' + records[0].id && value) race.onGet = () => { throw new Error('Storage unavailable') }
        }
    }
    race.run(second, start)
    expect(race.sends).toEqual(['A'])
    expect(second.result).toBe('This action completed in another tab. Refresh to see the result.')
    expect(race.run(second, 'queue.pendingMutations().length')).toBe(0)
})

it('keeps completion proof when a failed retry write races with completion', async () => {
    const { storageRace, records, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(records.map(job => ({ ...job, status: 'failed', error: 'Rejected' })))
    const first = race.tab('A'), second = race.tab('A')
    let interleaved = false
    race.onBeforeSet = key => {
        if (!key.startsWith('pancake:offline-mutation-retry:v1:')) return
        race.onBeforeSet = undefined
        race.run(first, 'queue.retryMutation(input.id);' + start)
        race.run(second, 'queue.pendingMutations()')
        interleaved = true
        race.onGet = () => { throw new Error('Storage unavailable') }
        throw new Error('Disk full')
    }
    race.run(second, 'try {queue.retryMutation(input.id)} catch {}')
    race.run(second, start)
    expect(interleaved).toBe(true)
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
    race.onBeforeSet = key => { if (key === 'pancake:offline-mutation:v1:B:' + records[1].id) throw new Error('QuotaExceededError') }
    const first = race.tab('A')
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
    race.onBeforeSet = key => { if (key === 'pancake:offline-mutation:v1:A:' + records[1].id) throw new Error('QuotaExceededError') }
    const first = race.tab('A')
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
    expect(first.result).toBe('Could not read your pending actions. Refresh and retry.')
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

it.each(['transient', 'persistent'] as const)('does not resend completed work when its marker read is %s', async fault => {
    const { storageRace, records, completionPrefix, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([records[0]])
    const first = race.tab('A'), stale = race.tab('A')
    race.run(stale, enqueue)
    race.run(first, start)
    const marker = completionPrefix + 'A:' + records[0].id
    expect(race.values.has(marker)).toBe(true)
    let reads = 0
    race.onGet = key => { if (key === marker && (fault === 'persistent' || ++reads === 1)) throw new Error('Read unavailable') }
    race.run(stale, start)
    expect(race.sends).toEqual(['A'])
    expect(stale.result).toBe(fault === 'transient' ? 'This action completed in another tab. Refresh to see the result.' : 'Could not read your pending actions. Refresh and retry.')
    race.onGet = undefined
    race.run(stale, 'queue.retryMutation(input.id);' + start)
    expect(race.sends).toEqual(['A'])
    expect(race.run(stale, 'queue.pendingMutations().length')).toBe(0)
})

it('uses a readable deleted input when completion becomes unreadable after the storage snapshot', async () => {
    const { storageRace, records, completionPrefix, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([records[0]])
    const first = race.tab('A'), stale = race.tab('A')
    race.run(stale, enqueue)
    const marker = completionPrefix + 'A:' + records[0].id
    race.onGet = key => {
        if (key !== marker) return
        race.onGet = undefined
        race.run(first, start)
        race.onGet = name => { if (name === marker) throw new Error('Read unavailable') }
    }
    race.run(stale, start)
    expect(race.sends).toEqual(['A'])
    expect(stale.result).toBe('This action completed in another tab. Refresh to see the result.')
    race.onGet = undefined
    race.run(stale, start)
    expect(race.sends).toEqual(['A'])
    expect(race.run(stale, 'queue.pendingMutations().length')).toBe(0)
})

it.each(['available', 'unavailable'] as const)('notifies subscribers when replay observes another tab’s rejection with %s storage', async availability => {
    const { storageRace, records, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([records[0]])
    const first = race.tab('A'), stale = race.tab('A')
    race.run(stale, enqueue + ';shown=queue.mutationSnapshot()[0].status;notices=0;queue.subscribeMutations(()=>{notices++;shown=queue.mutationSnapshot()[0]?.status})')
    race.run(first, 'queue.configureMutationReplay(async()=>{record();throw Error("Rejected")});' + start)
    if (availability === 'unavailable') race.onGet = key => { if (key === 'pancake:offline-mutations:v1') throw Error('Read unavailable') }
    race.run(stale, start)
    expect(stale.result).toBe('Rejected')
    expect(stale.shown).toBe('failed')
    expect(stale.notices).toBeGreaterThan(0)
    expect(race.sends).toEqual(['A'])
})


it.each(['browser', 'memory'] as const)('preserves enqueue order when the wall clock rolls backward in %s mode', async mode => {
    const { storageRace, records, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(), first = race.tab('A')
    if (mode === 'memory') race.run(first, 'delete globalThis.window')
    first.input = { ...records[0], path: '/first' }
    race.run(first, enqueue)
    race.now -= 1000
    first.input = { ...records[1], accountId: 'A', path: '/second' }
    race.run(first, enqueue)
    race.run(first, 'paths=[];queue.configureMutationReplay(async job=>{paths.push(job.path);return "saved"})')
    race.run(first, start)
    expect(Array.from(first.paths)).toEqual(['/first', '/second'])
})

it('imports legacy jobs in array order despite reversed creation times', async () => {
    const { storageRace, records, start } = await import('../../helpers/mutation-storage-race')
    const legacy = records.map((job, index) => ({ ...job, accountId: 'A', path: index ? '/second' : '/first', createdAt: index ? 1 : 1000 }))
    const race = storageRace(legacy), first = race.tab('A')
    race.run(first, 'paths=[];queue.configureMutationReplay(async job=>{paths.push(job.path);return "saved"})')
    race.run(first, start)
    expect(Array.from(first.paths)).toEqual(['/first', '/second'])
})

it.each(['{invalid', 'null', '{}'])('preserves a valid saved failure beneath a corrupt input record %s', async corrupt => {
    const { storageRace, records, start } = await import('../../helpers/mutation-storage-race')
    const job = { ...records[0], status: 'failed' as const, error: 'Rejected' }
    const race = storageRace([job])
    race.values.set('pancake:offline-mutation:v1:A:' + job.id, corrupt)
    const first = race.tab('A')
    const before = race.run(first, 'queue.pendingMutations()[0].status')
    race.run(first, start)
    expect(before).toBe('failed')
    expect(race.sends).toEqual([])
    expect(race.run(first, 'queue.pendingMutations().length')).toBe(1)
})


it('uses a deterministic job-key tie break for equal persisted order values', async () => {
    const { storageRace, records, start } = await import('../../helpers/mutation-storage-race')
    const legacy = records.map((job, index) => ({ ...job, accountId: 'A', path: index ? '/second' : '/first', order: 7 })).reverse()
    const race = storageRace(legacy), first = race.tab('A')
    race.run(first, 'paths=[];queue.configureMutationReplay(async job=>{paths.push(job.path);return "saved"})')
    race.run(first, start)
    expect(Array.from(first.paths)).toEqual(['/first', '/second'])
})

it('places a legacy record without order after earlier ordered records in the same array', async () => {
    const { storageRace, records, start } = await import('../../helpers/mutation-storage-race')
    const legacy = records.map((job, index) => ({ ...job, accountId: 'A', path: index ? '/second' : '/first', ...(index ? {} : { order: 2_000_000_000_000 }) }))
    const race = storageRace(legacy), first = race.tab('A')
    race.run(first, 'paths=[];queue.configureMutationReplay(async job=>{paths.push(job.path);return "saved"})')
    race.run(first, start)
    expect(Array.from(first.paths)).toEqual(['/first', '/second'])
})

it('does not send when a corrupt input has no valid fallback', async () => {
    const { storageRace, records, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([records[0]])
    const invalid = 'pancake:offline-mutation:v1:B:' + records[1].id
    race.values.set(invalid, '{invalid')
    const first = race.tab('A')
    race.run(first, start)
    expect(race.sends).toEqual([])
    expect(race.values.get(invalid)).toBe('{invalid')
    expect(race.run(first, 'queue.pendingMutations()[0].status')).toBe('failed')
})

it.each(['failure', 'retry', 'done'] as const)('does not send through a corrupt %s record', async kind => {
    const { storageRace, records, start } = await import('../../helpers/mutation-storage-race')
    const job = { ...records[0], status: 'failed' as const, error: 'Rejected' }
    const race = storageRace([job])
    const id = `A:${job.id}`
    race.values.set('pancake:offline-mutation:v1:' + id, JSON.stringify({ ...job, status: 'pending', error: null }))
    const name = kind === 'done' ? 'pancake:offline-mutation-done:v1:' + id : `pancake:offline-mutation-${kind}:v1:${id}:corrupt`
    race.values.set(name, '{invalid')
    const first = race.tab('A')
    expect(race.run(first, 'queue.pendingMutations()[0].status')).toBe('failed')
    race.run(first, start)
    expect(race.sends).toEqual([])
    expect(race.run(first, 'queue.pendingMutations()[0].status')).toBe('failed')
})

it('does not acknowledge a rejection through a corrupt retry record', async () => {
    const { storageRace, records, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([records[0]])
    const id = `A:${records[0].id}`
    race.values.set(`pancake:offline-mutation-failure:v1:${id}:rejection`, JSON.stringify({ id, failureId: 'rejection', error: 'Rejected' }))
    race.values.set(`pancake:offline-mutation-retry:v1:${id}:corrupt`, JSON.stringify({ id, failures: ['rejection', 123] }))
    const first = race.tab('A')
    race.run(first, start)
    expect(race.sends).toEqual([])
    expect(race.run(first, 'queue.pendingMutations()[0].error')).toBe('Rejected')
})

it('resumes later actions when an old account send settles after a read fault', async () => {
    const { storageRace, records, start, enqueue } = await import('../../helpers/mutation-storage-race')
    const race = storageRace()
    const tab = race.tab('A')
    race.run(tab, enqueue)
    race.run(tab, 'queue.configureMutationReplay(job=>{record();if(job.path==="/action")return new Promise(resolve=>finish=resolve);return Promise.resolve("saved")});' + start)
    race.run(tab, 'session.setSessionOwner("B");session.setSessionOwner("A");navigator.onLine=false')
    tab.input = { ...records[1], accountId: 'A', path: '/second' }
    race.run(tab, 'result="pending";' + enqueue)
    race.onGet = key => { if (key === 'pancake:offline-mutations:v1') throw new Error('Temporary read failure') }
    race.run(tab, start)
    race.onGet = undefined
    race.run(tab, 'finish("saved")')
    expect(race.sends).toEqual(['A', 'A'])
    expect(tab.result).toBe('saved')
    expect(race.run(tab, 'queue.pendingMutations().map(job=>job.path)')).toEqual([])
})

it('retries a transient completion write before a stale tab replays', async () => {
    const { storageRace, records, start, enqueue, completionPrefix } = await import('../../helpers/mutation-storage-race')
    const race = storageRace()
    const writer = race.tab('A')
    writer.console = { ...console, error: () => {} }
    race.run(writer, enqueue)
    const stale = race.tab('A')
    race.onBeforeSet = key => {
        if (!key.startsWith(completionPrefix)) return
        race.onBeforeSet = undefined
        throw new Error('Transient write failure')
    }
    race.run(writer, start)
    race.run(writer, 'queue.replayMutations()')
    expect(race.values.has(completionPrefix + 'A:' + records[0].id)).toBe(true)
    race.run(stale, start)
    expect(race.sends).toEqual(['A'])
    expect(race.run(stale, 'queue.pendingMutations().length')).toBe(0)
})

it.each(['read', 'replay', 'enqueue', 'retry'] as const)('saves retained completions before %s after storage recovers', async recovery => {
    const { storageRace, records, start, enqueue, completionPrefix } = await import('../../helpers/mutation-storage-race')
    const race = storageRace()
    const writer = race.tab('A')
    writer.console = { ...console, error: () => {} }
    race.run(writer, enqueue)
    const stale = race.tab('A')
    const id = 'A:' + records[0].id
    race.onBeforeSet = key => { if (key.startsWith(completionPrefix)) throw new Error('Storage unavailable') }
    race.run(writer, start)
    expect(writer.result).toBe('saved')
    expect(race.values.has('pancake:offline-mutation:v1:' + id)).toBe(false)
    expect(race.values.has('pancake:offline-mutations:v1')).toBe(false)
    expect(race.values.has(completionPrefix + id)).toBe(false)
    writer.input = { ...records[1], accountId: 'A', path: '/second' }
    if (recovery === 'retry') {
        const second = { ...writer.input, status: 'failed', error: 'Rejected' }
        race.values.set('pancake:offline-mutation:v1:A:' + second.id, JSON.stringify(second))
    }
    const earlyOperations: string[] = []
    const checkSaved = (operation: string) => { if (!race.values.has(completionPrefix + id)) earlyOperations.push(operation) }
    race.onGet = () => checkSaved('read')
    race.onRemove = () => checkSaved('remove')
    race.onBeforeSet = key => { if (!key.startsWith(completionPrefix)) checkSaved('write') }
    race.run(writer, recovery === 'read' ? 'queue.pendingMutations()' : recovery === 'replay' ? start : recovery === 'retry' ? 'queue.retryMutation(input.id)' : enqueue)
    expect(race.values.has(completionPrefix + id)).toBe(true)
    race.run(stale, start)
    expect(earlyOperations).toEqual([])
    expect(race.sends).toEqual(recovery === 'enqueue' || recovery === 'retry' ? ['A', 'A'] : ['A'])
})

it('retains the physical-limit fallback when writes and removals both fail', async () => {
    const { storageRace, start, enqueue, completionPrefix } = await import('../../helpers/mutation-storage-race')
    const race = storageRace()
    const writer = race.tab('A')
    writer.console = { ...console, error: () => {} }
    race.run(writer, enqueue)
    const stale = race.tab('A')
    stale.console = writer.console
    let removals = 0
    race.onBeforeSet = () => { throw new Error('Storage unavailable') }
    race.onRemove = () => { removals++; throw new Error('Removal unavailable') }
    race.run(writer, start)
    expect(writer.result).toBe('saved')
    race.run(writer, 'queue.replayMutations()')
    expect(race.sends).toEqual(['A'])
    expect(removals).toBeGreaterThan(0)
    expect([...race.values.keys()].some(key => key.startsWith(completionPrefix))).toBe(false)
    race.run(stale, start)
    expect(race.sends).toEqual(['A', 'A'])
})

it('preserves all 64 offline actions under persistent cache pressure', async () => {
    const { cachePressure } = await import('../../helpers/mutation-storage-race')
    expect(cachePressure()).toBe(64)
})

it('keeps a completed action from resending after eight days', async () => {
    const { agedCompletion } = await import('../../helpers/mutation-storage-race')
    expect(agedCompletion()).toEqual({ sends: 1, pending: 0 })
})

it('keeps deleted input as proof after aged completion cleanup', async () => {
    const { storageRace, records, completionPrefix, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(), writer = race.tab('A')
    race.run(writer, enqueue)
    const stale = race.tab('A')
    race.run(writer, start)
    race.now += 8 * 24 * 60 * 60 * 1000
    writer.input = { ...records[1], accountId: 'A' }
    race.run(writer, enqueue + ';' + start)
    expect(race.values.has(completionPrefix + 'A:' + records[0].id)).toBe(false)
    race.run(stale, start)
    expect(race.sends).toEqual(['A', 'A'])
    expect(race.run(stale, 'queue.pendingMutations().length')).toBe(0)
})

it('protects every queue prefix from eviction but removes all of them on forced clear', async () => {
    const { storageRace, persistentCache } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(), tab = race.tab('A')
    const names = ['pancake:offline-mutations:v1', ...['', '-done', '-failure', '-retry'].map(suffix => `pancake:offline-mutation${suffix}:v1:A:test`)]
    for (const name of names) race.values.set(name, '[]')
    const cache = persistentCache(tab)
    for (let index = 0; index < 65; index++) cache.writePersistentCache(`pancake:test:${index}`, {})
    for (const name of names) expect(race.values.get(name)).toBe('[]')
    let fail = true
    race.onBeforeSet = name => { if (name === 'pancake:test:quota' && fail) { fail = false; throw new Error('Quota') } }
    cache.writePersistentCache('pancake:test:quota', {})
    cache.clearPersistentCaches()
    expect([...race.values.keys()]).toEqual([])
})

it('retains aged completion proof while its input deletion fails', async () => {
    const { storageRace, records, completionPrefix, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(), writer = race.tab('A')
    race.run(writer, enqueue)
    const inputName = 'pancake:offline-mutation:v1:A:' + records[0].id
    race.onRemove = name => {
        if (name !== inputName) return
        race.now += 8 * 24 * 60 * 60 * 1000
        throw new Error('Removal unavailable')
    }
    race.run(writer, start)
    expect(race.values.has(inputName)).toBe(true)
    expect(race.values.has(completionPrefix + 'A:' + records[0].id)).toBe(true)
    const stale = race.tab('A')
    race.run(stale, start)
    expect(race.sends.filter(account => account === 'A')).toHaveLength(1)
})

it('retains old completion proof while a legacy backup still contains the job', async () => {
    const { storageRace, records, completionPrefix, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(), writer = race.tab('A')
    race.run(writer, enqueue)
    const backup = 'pancake:offline-mutations:v1'
    race.onBeforeSet = name => { if (name === backup) throw new Error('Backup write unavailable') }
    race.onRemove = name => { if (name === backup) throw new Error('Backup removal unavailable') }
    race.run(writer, start)
    race.now += 8 * 24 * 60 * 60 * 1000
    writer.input = { ...records[1], accountId: 'A' }
    race.run(writer, enqueue + ';' + start)
    expect(race.values.has(completionPrefix + 'A:' + records[0].id)).toBe(true)
    expect(race.run(race.tab('A'), 'queue.pendingMutations().length')).toBe(0)
    expect(race.sends).toEqual(['A', 'A'])
})

it('does not infer completion or send when the deleted input cannot be read', async () => {
    const { storageRace, records, completionPrefix, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(), writer = race.tab('A')
    race.run(writer, enqueue)
    const stale = race.tab('A')
    race.run(writer, start)
    race.values.delete(completionPrefix + 'A:' + records[0].id)
    race.onGet = name => { if (name === 'pancake:offline-mutation:v1:A:' + records[0].id) throw new Error('Input unavailable') }
    race.run(stale, start)
    expect(race.sends).toEqual(['A'])
    expect(race.run(stale, 'queue.pendingMutations()[0].status')).toBe('failed')
})

it.each(['forced clear', 'sign-out'] as const)('drops saved queued bodies and current callers on %s like main', async mode => {
    const { storageRace, persistentCache, enqueue } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(), tab = race.tab('A')
    race.run(tab, enqueue)
    expect(race.run(tab, 'queue.pendingMutations().length')).toBe(1)
    persistentCache(tab).clearPersistentCaches()
    if (mode === 'sign-out') race.run(tab, 'session.setSessionOwner(null)')
    race.run(tab, 'queue.pendingMutations("A")')
    expect([...race.values.keys()].filter(name => name.startsWith('pancake:offline-mutation'))).toEqual([])
    expect(race.run(tab, 'queue.pendingMutations("A").length')).toBe(0)
    expect(tab.result).toBe('Your account changed. Please retry.')
})

it('discards legacy imports on forced cache clear without replaying them', async () => {
    const { legacyClear } = await import('../../helpers/mutation-storage-race')
    expect(legacyClear()).toEqual({ case: 'clear', pending: 0, sends: 0 })
})

it('does not replay a successful action after full quota and reload', async () => {
    const { quotaReload } = await import('../../helpers/mutation-storage-race')
    expect(quotaReload()).toEqual({ case: 'quota', caller: 'saved', sends: 1 })
})

it.each(['success', 'rejection', 'offline rejection'] as const)('does not restore an in-flight action after forced clear and %s', async outcome => {
    const { storageRace, persistentCache, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(), tab = race.tab('A')
    race.run(tab, enqueue)
    race.run(tab, 'queue.subscribeMutations(()=>queue.pendingMutations());queue.configureMutationReplay(()=>{record();return new Promise((resolve,reject)=>{finish=resolve;fail=reject})});' + start)
    persistentCache(tab).clearPersistentCaches()
    expect(race.run(tab, 'queue.pendingMutations().length')).toBe(0)
    if (outcome === 'success') race.run(tab, 'finish("saved")')
    else race.run(tab, (outcome === 'offline rejection' ? 'navigator.onLine=false;' : '') + 'fail(new Error("Rejected"))')
    expect(race.values.size).toBe(0)
    expect(race.run(tab, 'queue.pendingMutations().length')).toBe(0)
    expect(tab.result).toBe('Your account changed. Please retry.')
    expect(race.sends).toEqual(['A'])
})

it('drops an unsaved completion on forced clear instead of writing it back later', async () => {
    const { storageRace, persistentCache, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(), tab = race.tab('A')
    tab.console = { ...console, error() {} }
    race.run(tab, enqueue)
    race.onBeforeSet = () => { throw new Error('QuotaExceededError') }
    race.run(tab, start)
    persistentCache(tab).clearPersistentCaches()
    race.onBeforeSet = undefined
    race.run(tab, 'queue.pendingMutations();' + start)
    expect(race.values.size).toBe(0)
    expect(race.sends).toEqual(['A'])
})

it('preserves another account’s saved action during completion under quota', async () => {
    const { storageRace, records, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(), a = race.tab('A')
    a.console = { ...console, error() {} }
    race.run(a, enqueue)
    race.run(a, 'queue.configureMutationReplay(()=>{record();return new Promise(resolve=>finish=resolve)});' + start)
    const b = race.tab('B')
    b.console = a.console
    race.run(b, enqueue)
    race.onBeforeSet = () => { throw new Error('QuotaExceededError') }
    race.run(a, 'finish("saved")')
    const restoredA = race.tab('A'), restoredB = race.tab('B')
    restoredA.console = restoredB.console = a.console
    expect(race.run(restoredA, 'queue.pendingMutations().length')).toBe(0)
    expect(race.run(restoredB, 'queue.pendingMutations().map(job=>job.id)')).toEqual([records[1].id])
    race.run(restoredA, start)
    race.run(restoredB, start)
    expect(race.sends).toEqual(['A', 'B'])
})

it('does not carry a discarded legacy rejection into a new action with the same key', async () => {
    const { storageRace, persistentCache, records, enqueue } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([{ ...records[0], status: 'failed', error: 'Discarded rejection' }]), tab = race.tab('A')
    expect(race.run(tab, 'queue.pendingMutations()[0].status')).toBe('failed')
    persistentCache(tab).clearPersistentCaches()
    race.run(tab, enqueue)
    expect(race.run(tab, 'queue.pendingMutations().map(job=>({status:job.status,error:job.error}))')).toEqual([{ status: 'pending', error: null }])
})

it.each([false, true])('keeps completion proof safe when cleanup races with restored input %s', async restoreInput => {
    const { cleanupReplayRace } = await import('../../helpers/mutation-storage-race')
    expect(cleanupReplayRace(restoreInput)).toEqual({ interleaved: true, entryWithoutCompletion: false, replayedPaths: [] })
})

it('bounds retry history through 30 completed actions under an 8 KiB quota', async () => {
    const { retryStorageGrowth } = await import('../../helpers/mutation-storage-race')
    expect(retryStorageGrowth()).toEqual({ completed: 30, pending: 0, retainedFacts: 0, blocked: null })
})

it.each(['failure', 'retry'] as const)('ages orphaned %s facts without deleting recent or live facts', async kind => {
    const { storageRace, records, enqueue } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(), tab = race.tab('A')
    const id = 'B:' + records[1].id, prefix = `pancake:offline-mutation-${kind}:v1:`
    const value = kind === 'failure' ? { id, failureId: 'orphan', error: 'Rejected' } : { id, failures: ['orphan'] }
    const old = prefix + id + ':orphan', recent = prefix + id + ':recent'
    race.values.set(old, JSON.stringify({ ...value, createdAt: race.now - 8 * 86400000 }))
    race.values.set(recent, JSON.stringify({ ...value, ...(kind === 'failure' ? { failureId: 'recent' } : {}), createdAt: race.now }))
    race.run(tab, enqueue)
    expect(race.values.has(old)).toBe(false)
    expect(race.values.has(recent)).toBe(true)
    const live = { ...records[1], status: 'pending', error: null }
    race.values.set('pancake:offline-mutation:v1:' + id, JSON.stringify(live))
    race.now += 8 * 86400000
    race.run(tab, 'queue.retryMutation("absent")')
    expect(race.values.has(recent)).toBe(true)
})

it.each(['failure', 'retry', 'done'] as const)('retains old or malformed orphan %s metadata for a full observation window', async kind => {
    const { storageRace, records, enqueue } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(), tab = race.tab('A')
    const id = 'B:' + records[1].id, prefix = `pancake:offline-mutation-${kind}:v1:`
    const old = prefix + id + (kind === 'done' ? '' : ':old')
    const malformed = prefix + 'B:10000000-0000-4000-8000-000000000003' + (kind === 'done' ? '' : ':corrupt')
    race.values.set(old, kind === 'failure' ? JSON.stringify({ id, failureId: 'old', error: 'Rejected' }) : kind === 'retry' ? JSON.stringify({ id, failures: ['old'] }) : 'invalid')
    race.values.set(malformed, '{invalid')
    race.run(tab, enqueue)
    const stamped = JSON.parse(race.values.get(old)!)
    expect(stamped.createdAt).toBe(race.now)
    if (kind === 'failure') expect(stamped.error).toBe('Rejected')
    if (kind === 'retry') expect(stamped.failures).toEqual(['old'])
    expect(JSON.parse(race.values.get(malformed)!).orphanedValue).toBe('{invalid')
    race.now += 7 * 86400000
    race.run(tab, 'queue.retryMutation("absent")')
    expect(race.values.has(old)).toBe(true)
    race.now++
    race.run(tab, 'queue.retryMutation("absent")')
    expect(race.values.has(old)).toBe(false)
    expect(race.values.has(malformed)).toBe(false)
})

it.each(['failure', 'retry'] as const)('restores an aged orphan %s fact if its input reappears during deletion', async kind => {
    const { storageRace, records, enqueue } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(), tab = race.tab('A')
    const id = 'B:' + records[1].id, entry = 'pancake:offline-mutation:v1:' + id
    const name = `pancake:offline-mutation-${kind}:v1:` + id + ':orphan'
    const value = JSON.stringify({ id, ...(kind === 'failure' ? { failureId: 'orphan', error: 'Rejected' } : { failures: ['orphan'] }), createdAt: race.now - 8 * 86400000 })
    race.values.set(name, value)
    race.onRemove = key => {
        if (key !== name) return
        race.onRemove = undefined
        race.values.set(entry, JSON.stringify(records[1]))
    }
    race.run(tab, enqueue)
    expect(race.values.get(name)).toBe(value)
    expect(race.values.has(entry)).toBe(true)
})

it('preserves a rejection after reload under a tight quota', async () => {
    const { rejectedQuotaReload } = await import('../../helpers/mutation-storage-race')
    expect(rejectedQuotaReload()).toEqual({ caller: 'Rejected', before: 'failed', reloaded: 'failed', sends: 1 })
})

it('bounds one live action through 30 retries under an 8 KiB quota', async () => {
    const { liveRetryStorageGrowth } = await import('../../helpers/mutation-storage-race')
    expect(liveRetryStorageGrowth()).toEqual({ retries: 30, pending: 0, retryError: null })
})

it('keeps one current fact and makes stale tabs observe compacted retries', async () => {
    const { storageRace, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(), writer = race.tab('A'), stale = race.tab('A')
    race.run(writer, enqueue + ';queue.configureMutationReplay(async()=>{throw Error("Rejected")});' + start)
    race.run(stale, 'queue.pendingMutations()')
    const facts = () => [...race.values.keys()].filter(name => name.includes('-failure:') || name.includes('-retry:'))
    for (let index = 0; index < 30; index++) {
        race.run(writer, 'navigator.onLine=false;queue.retryMutation(input.id)')
        expect(facts()).toHaveLength(1)
        expect(facts()[0]).toContain('-retry:')
        expect(race.run(stale, 'queue.pendingMutations()[0].status')).toBe('pending')
        expect(race.run(race.tab('A'), 'queue.pendingMutations()[0].status')).toBe('pending')
        race.run(writer, start)
        expect(facts()).toHaveLength(1)
        expect(facts()[0]).toContain('-failure:')
        expect(race.run(stale, 'queue.pendingMutations()[0].status')).toBe('failed')
        expect(race.run(race.tab('A'), 'queue.pendingMutations()[0].status')).toBe('failed')
    }
})

it('retries a quota-blocked retry fact once after compaction', async () => {
    const { storageRace, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(), tab = race.tab('A')
    race.run(tab, enqueue + ';queue.configureMutationReplay(async()=>{throw Error("Rejected")});' + start)
    race.run(tab, 'navigator.onLine=false')
    let writes = 0
    race.onBeforeSet = name => {
        if (name.startsWith('pancake:offline-mutation-retry:v1:') && ++writes === 1) throw new Error('QuotaExceededError')
    }
    expect(() => race.run(tab, 'queue.retryMutation(input.id)')).not.toThrow()
    expect(writes).toBe(2)
    expect(race.run(race.tab('A'), 'queue.pendingMutations()[0].status')).toBe('pending')
})

it('keeps the rejection when both retry fact writes exceed quota', async () => {
    const { storageRace, enqueue, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(), tab = race.tab('A')
    race.run(tab, enqueue + ';queue.configureMutationReplay(async()=>{throw Error("Rejected")});' + start)
    let writes = 0
    race.onBeforeSet = name => {
        if (name.startsWith('pancake:offline-mutation-retry:v1:')) { writes++; throw new Error('QuotaExceededError') }
    }
    expect(() => race.run(tab, 'queue.retryMutation(input.id)')).toThrow('Could not save your pending action.')
    expect(writes).toBe(2)
    const restored = race.tab('A')
    expect(race.run(restored, 'queue.pendingMutations()[0].status')).toBe('failed')
    race.run(restored, start)
    expect(race.sends).toEqual([])
})

it('does not replay a legacy-only snapshot after another tab imports and completes it', async () => {
    const { expiredLegacyCompletion } = await import('../../helpers/mutation-storage-race')
    expect(expiredLegacyCompletion()).toEqual({ case: 'expired legacy completion', paths: ['/action', '/next'] })
})

it('blocks a rejection written during the snapshot scan before sending', async () => {
    const { rejectionDuringScan } = await import('../../helpers/mutation-storage-race')
    expect(rejectionDuringScan()).toEqual({ case: 'rejection during scan', statusBeforeSend: 'failed', sends: ['A'], caller: 'Rejected', pending: 1 })
})

it.each([1, 2, 4])('revalidates a rejection arriving at completion read %i before dispatch', async readNumber => {
    const { rejectionDuringScan } = await import('../../helpers/mutation-storage-race')
    expect(rejectionDuringScan(readNumber)).toEqual({ case: 'rejection during scan', statusBeforeSend: 'failed', sends: ['A'], caller: 'Rejected', pending: 1 })
})

it('refuses a retry acknowledgement corrupted during the final record scan', async () => {
    const { storageRace, records, completionPrefix, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([{ ...records[0], status: 'failed', error: 'Rejected' }]), tab = race.tab('A')
    tab.console = { ...console, error() {} }
    race.run(tab, 'queue.retryMutation(input.id)')
    const retry = [...race.values.keys()].find(name => name.startsWith('pancake:offline-mutation-retry:v1:'))!
    let reads = 0
    race.onGet = name => {
        if (name !== completionPrefix + 'A:' + records[0].id || ++reads !== 3) return
        race.onGet = undefined
        race.values.set(retry, '{invalid')
    }
    race.run(tab, start)
    expect(reads).toBe(3)
    expect(race.sends).toEqual([])
    expect(race.run(tab, 'queue.pendingMutations()[0].status')).toBe('failed')
})

it('repairs an invalid input from a valid pending legacy copy before the send gate', async () => {
    const { storageRace, records, start } = await import('../../helpers/mutation-storage-race')
    const race = storageRace([records[0]])
    race.values.set('pancake:offline-mutation:v1:A:' + records[0].id, '{invalid')
    const tab = race.tab('A')
    tab.console = { ...console, error() {} }
    race.run(tab, start)
    expect(race.sends).toEqual(['A'])
    expect(race.run(tab, 'queue.pendingMutations().length')).toBe(0)
})

it('does not reject a new enqueue after its sole required input write succeeds', async () => {
    const { storageRace, records, enqueue } = await import('../../helpers/mutation-storage-race')
    const race = storageRace(), tab = race.tab('A')
    tab.console = { ...console, error() {} }
    let writes = 0
    race.onBeforeSet = name => {
        if (name === 'pancake:offline-mutation:v1:A:' + records[0].id && ++writes > 1) throw new Error('Storage became read-only')
    }
    race.run(tab, enqueue)
    expect(tab.result).toBe('pending')
    expect(race.run(tab, 'queue.pendingMutations().length')).toBe(1)
    expect(writes).toBe(1)
})
