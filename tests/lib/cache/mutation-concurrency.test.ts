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
    race.onBeforeSet = key => {
        if (key !== 'pancake:offline-mutations:v1') return
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
