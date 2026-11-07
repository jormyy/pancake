import { enumerableStorage } from '../../helpers/enumerable-storage'
import { afterEach, expect, it, vi } from 'vitest'
import { agedCompletion, cachePressure, cleanupRace, enqueueRace, expiredLegacyCompletion, rejectionDuringScan, legacyClear, quotaReload, retryStorageGrowth, liveRetryStorageGrowth } from '../../helpers/mutation-storage-race'
import { runCompletionRace } from '../../helpers/mutation-completion-race'
import type { QueuedMutation } from '@/lib/cache/mutation-queue'

const completionKey = 'pancake:offline-mutation-completions:v1'
const completionPrefix = 'pancake:offline-mutation-done:v1:'
const queueKey = 'pancake:offline-mutations:v1'
const entryPrefix = 'pancake:offline-mutation:v1:'
const failurePrefix = 'pancake:offline-mutation-failure:v1:'
const retryPrefix = 'pancake:offline-mutation-retry:v1:'
const seeds = [1, 7, 42, 2026, 65537, 104729, 3735928559, 4277009102]
type Action = { id: string; accountId: string; phase: 'pending' | 'sending' | 'failed' | 'settled'; sends: number; allowance: number; outcomeAt: number; error?: string }
type Held = { resolve: () => void; reject: () => void }

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each(seeds)('preserves queue invariants through seeded sequence %i', async seed => {
    vi.resetModules()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let randomState = seed >>> 0
    const random = (limit: number) => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState % limit }
    const pick = <T,>(items: T[]) => items.length ? items[random(items.length)] : undefined
    const actions = new Map<string, Action>()
    const held = new Map<string, Held>()
    const violations: string[] = []
    const trace: string[] = []
    const coverage: Record<string, number> = {}
    let saved: string | undefined = '{invalid'
    let completedSaved: string | undefined
    const completionValues = new Map<string, string>()
    const entryValues = new Map<string, string>()
    const eventValues = new Map<string, string>()
    const callers = new Map<string, unknown>()
    const waiting = new Set<string>()
    const overwritten = new Set<string>()
    let wallNow = Date.now()
    let observedOrder = 0
    vi.spyOn(Date, 'now').mockImplementation(() => wallNow)
    let online = false
    let failures = 0
    let readFault = false
    let completionWriteFailures = 0
    let serial = 0
    let clock = 0
    let savedAt = 0
    let account = 'A'
    let stepCount = 0
    const disk = (): QueuedMutation[] => {
        let legacy: QueuedMutation[] = []
        try { const value: unknown = JSON.parse(saved ?? '[]'); if (Array.isArray(value)) legacy = value } catch {}
        const entries = [...entryValues.values()].flatMap(value => { try { const job = JSON.parse(value); return job && typeof job.id === 'string' ? [job as QueuedMutation] : [] } catch { return [] } })
        return [...new Map([...legacy, ...entries].map(job => [job.id, job])).values()].filter(job => { const value = Number(completionValues.get(completionPrefix + `${job.accountId}:${job.id}`)); return !Number.isFinite(value) || value <= 0 }).map(job => {
            const id = `${job.accountId}:${job.id}`
            const rejected = new Map<string, string>()
            if (job.status === 'failed') rejected.set('legacy', job.error ?? 'Could not send this action.')
            const retried = new Set<string>()
            for (const [name, raw] of eventValues) {
                let event
                try { event = JSON.parse(raw) } catch { continue }
                if (!event || event.id !== id) continue
                if (name.startsWith(failurePrefix) && typeof event.failureId === 'string' && typeof event.error === 'string') rejected.set(event.failureId, event.error)
                if (name.startsWith(retryPrefix) && Array.isArray(event.failures) && event.failures.every((id: unknown) => typeof id === 'string')) for (const failureId of event.failures) retried.add(failureId)
            }
            const open = [...rejected].filter(([failureId]) => !retried.has(failureId))
            return { ...job, status: open.length ? 'failed' : 'pending', error: open.at(-1)?.[1] ?? null } as QueuedMutation
        })
    }
    const storage = enumerableStorage({
        get length() { return (saved === undefined ? 0 : 1) + completionValues.size + entryValues.size + eventValues.size },
        key: (index: number) => [...(saved === undefined ? [] : [queueKey]), ...completionValues.keys(), ...entryValues.keys(), ...eventValues.keys()][index] ?? null,
        getItem: (name: string) => {
            if (readFault && name === queueKey) { coverage.readFailure = (coverage.readFailure ?? 0) + 1; throw new Error('Injected read failure') }
            return name === completionKey ? completedSaved ?? null : name === queueKey ? saved ?? null : completionValues.get(name) ?? entryValues.get(name) ?? eventValues.get(name) ?? null
        },
        setItem: (name: string, value: string) => {
            if (name === completionKey) { completedSaved = value; return }
            if (name.startsWith(completionPrefix)) {
                if (completionWriteFailures > 0) { completionWriteFailures--; coverage.completionWriteFailure = (coverage.completionWriteFailure ?? 0) + 1; throw new Error('Injected completion write failure') }
                completionValues.set(name, value); return
            }
            if (failures > 0) { failures--; coverage.writeFailure = (coverage.writeFailure ?? 0) + 1; throw new Error('Injected storage failure') }
            if (name.startsWith(failurePrefix) || name.startsWith(retryPrefix)) { eventValues.set(name, value); savedAt = ++clock; return }
            if (name.startsWith(entryPrefix)) { entryValues.set(name, value); savedAt = ++clock; return }
            saved = value
            overwritten.clear()
            savedAt = ++clock
        },
        removeItem: (name: string) => {
            if (name === completionKey) { completedSaved = undefined; return }
            if (name.startsWith(completionPrefix)) { completionValues.delete(name); return }
            if (failures > 0) { failures--; coverage.writeFailure = (coverage.writeFailure ?? 0) + 1; throw new Error('Injected removal failure') }
            if (name.startsWith(failurePrefix) || name.startsWith(retryPrefix)) { eventValues.delete(name); savedAt = ++clock; return }
            if (name.startsWith(entryPrefix)) { entryValues.delete(name); savedAt = ++clock; return }
            saved = undefined
            overwritten.clear()
            savedAt = ++clock
        },
    }, () => [...(saved === undefined ? [] : [queueKey]), ...completionValues.keys(), ...entryValues.keys(), ...eventValues.keys()])
    vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: storage }))
    vi.stubGlobal('navigator', { get onLine() { return online } })
    let session!: typeof import('@/lib/session-cache-registry')
    let queue!: typeof import('@/lib/cache/mutation-queue')
    const flush = async () => { for (let turn = 0; turn < 16; turn++) await Promise.resolve() }
    const start = () => { void queue.replayMutations().catch(error => violations.push(String(error))) }
    const load = async () => {
        session = await import('@/lib/session-cache-registry')
        session.setSessionOwner(account)
        queue = await import('@/lib/cache/mutation-queue')
        queue.configureMutationReplay(job => {
            const action = actions.get(job.id)!
            if (action.phase === 'failed') violations.push(`Rejected action sent without retry: ${job.id}`)
            if (++action.sends > action.allowance) violations.push(`Duplicate send: ${job.id}`)
            if (held.has(job.id)) violations.push(`Concurrent send: ${job.id}`)
            action.phase = 'sending'
            coverage.sendStarted = (coverage.sendStarted ?? 0) + 1
            return new Promise<string>((resolve, reject) => held.set(job.id, {
                resolve: () => resolve('saved'), reject: () => reject(new Error(`Rejected ${job.id}`)),
            }))
        })
    }
    const check = (label: string) => {
        const context = `seed=${seed} step=${stepCount} ${label} trace=${trace.slice(-8).join(' → ')}`
        expect(violations, context).toEqual([])
        const memory = new Map(queue.mutationSnapshot().map(job => [job.id, job]))
        const persisted = new Map(disk().map(job => [job.id, job]))
        for (const action of actions.values()) {
            expect(action.sends, context).toBeLessThanOrEqual(action.allowance)
            if (action.phase === 'settled') {
                expect(memory.has(action.id), context).toBe(false)
                if (savedAt >= action.outcomeAt) expect(persisted.has(action.id), context).toBe(false)
            } else {
                expect(memory.has(action.id), context).toBe(true)
                expect(persisted.has(action.id), context).toBe(!overwritten.has(action.id))
                if (action.phase === 'failed') {
                    expect(memory.get(action.id)?.status, context).toBe('failed')
                    expect(memory.get(action.id)?.error, context).toBe(action.error)
                    if (savedAt >= action.outcomeAt) {
                        expect(persisted.get(action.id)?.status, context).toBe('failed')
                        expect(persisted.get(action.id)?.error, context).toBe(action.error)
                    }
                }
            }
        }
    }
    const step = async (label: string, operation: () => unknown) => {
        stepCount++
        trace.push(label)
        coverage[label] = (coverage[label] ?? 0) + 1
        await operation()
        await flush()
        check(label)
    }
    const nextId = () => `${seed.toString(16).padStart(8, '0')}-0000-4000-8000-${(++serial).toString(16).padStart(12, '0')}`
    const enqueue = () => {
        const before = Math.max(observedOrder, ...queue.mutationSnapshot().map(job => job.order ?? 0))
        const id = nextId()
        const action: Action = { id, accountId: account, phase: 'pending', sends: 0, allowance: 1, outcomeAt: 0 }
        actions.set(id, action)
        waiting.add(id)
        void queue.queueMutation({ accountId: account, leagueId: null, rowIds: [id], path: `/sequence/${id}`, body: '{}' }, id).then(value => { waiting.delete(id); callers.set(id, value) }, error => { waiting.delete(id); callers.set(id, error.message) })
        const queued = queue.mutationSnapshot().find(job => job.id === id)
        if (!queued) actions.delete(id)
        else { expect(queued.order, String(seed)).toBeGreaterThan(before); observedOrder = queued.order! }
        return id
    }
    const release = (id: string | undefined, success: boolean) => {
        if (!id) return
        const control = held.get(id)
        if (!control) return
        const action = actions.get(id)!
        held.delete(id)
        coverage[success ? 'sendSuccess' : 'sendFailure'] = (coverage[success ? 'sendSuccess' : 'sendFailure'] ?? 0) + 1
        action.phase = success ? 'settled' : online ? 'failed' : 'pending'
        action.error = action.phase === 'failed' ? `Rejected ${id}` : undefined
        if (!success && !online) { action.allowance++; coverage.offlineFailure = (coverage.offlineFailure ?? 0) + 1 }
        else action.outcomeAt = ++clock
        if (success) control.resolve()
        else control.reject()
    }
    const retry = (id?: string) => {
        const action = id ? actions.get(id) : pick([...actions.values()].filter(item => item.accountId === account && item.phase !== 'settled'))
        if (!action) return
        const previous = { ...action }
        if (action.phase === 'failed') { action.phase = 'pending'; action.error = undefined; action.allowance++ }
        try {
            queue.retryMutation(action.id)
            if (previous.phase === 'failed') coverage.retryAccepted = (coverage.retryAccepted ?? 0) + 1
        } catch { Object.assign(action, previous) }
    }
    const switchAccount = () => {
        const persisted = new Map(disk().map(job => [job.id, job]))
        if ([...actions.values()].some(action => action.phase === 'failed' && persisted.get(action.id)?.status === 'pending')) coverage.unsavedRejectionSwitch = (coverage.unsavedRejectionSwitch ?? 0) + 1
        account = account === 'A' ? 'B' : 'A'
        session.setSessionOwner(account)
        start()
    }
    const markCompleted = (action: Action) => {
        const key = `${action.accountId}:${action.id}`
        completionValues.set(completionPrefix + key, String(Date.now()))
        const completed: string[] = JSON.parse(completedSaved ?? '[]')
        completedSaved = JSON.stringify([...completed.filter(id => id !== key), key].slice(-200))
    }
    const offlineExit = async (selectedId?: string) => {
        const id = selectedId ?? pick([...held.keys()].filter(id => actions.get(id)!.accountId === account && waiting.has(id)))
        if (!id || !held.has(id) || !waiting.has(id)) return
        const action = actions.get(id)!
        const control = held.get(id)!
        markCompleted(action)
        saved = JSON.stringify(disk().filter(job => job.id !== id))
        action.phase = 'settled'
        action.outcomeAt = ++clock
        queue.pendingMutations()
        online = false
        held.delete(id)
        control.reject()
        await flush()
        expect(callers.get(id), String(seed)).toBe('This action completed in another tab. Refresh to see the result.')
        coverage.offlineCompletedExitApplied = (coverage.offlineCompletedExitApplied ?? 0) + 1
    }
    const completionRace = async () => {
        const candidates = ['A', 'B'].map(owner => [...actions.values()].find(action => action.accountId === owner && action.phase === 'pending' && !held.has(action.id) && !overwritten.has(action.id)))
        if (candidates.some(action => !action)) return
        const racing = candidates as Action[]
        const records = racing.map(action => disk().find(job => job.id === action.id)!)
        expect(records.every(Boolean), String(seed)).toBe(true)
        const result = await runCompletionRace(records)
        expect(result.retained, String(seed)).toHaveLength(2)
        expect(result.duplicates, String(seed)).toBe(0)
        for (const action of racing) {
            action.sends++
            action.phase = 'settled'
            action.outcomeAt = ++clock
            markCompleted(action)
        }
        saved = JSON.stringify(disk().filter(job => !racing.some(action => action.id === job.id)))
        const wasOnline = online
        online = false
        switchAccount()
        switchAccount()
        online = wasOnline
        start()
        coverage.completionRaceApplied = (coverage.completionRaceApplied ?? 0) + 1
    }
    const otherTab = (operation: 'reject' | 'complete' | 'enqueue', selectedId?: string) => {
        const action: Action | undefined = operation === 'enqueue'
            ? { id: nextId(), accountId: account === 'A' ? 'B' : 'A', phase: 'pending', sends: 0, allowance: 1, outcomeAt: 0 }
            : selectedId ? actions.get(selectedId) : pick([...actions.values()].filter(item => item.phase === 'pending' || operation !== 'reject' && item.phase === 'failed'))
        if (!action || held.has(action.id) || action.phase === 'settled') return
        const wasOnline = online
        online = false
        const records = disk()
        if (operation === 'enqueue') {
            actions.set(action.id, action)
            const job: QueuedMutation = { id: action.id, accountId: action.accountId, leagueId: null, rowIds: [action.id], path: `/external/${action.id}`, body: '{}', status: 'pending', error: null, createdAt: Date.now() }
            entryValues.set(entryPrefix + `${job.accountId}:${job.id}`, JSON.stringify(job))
            saved = JSON.stringify([...records, job])
            coverage.externalEnqueueApplied = (coverage.externalEnqueueApplied ?? 0) + 1
        } else {
            expect(records.some(job => job.id === action.id)).toBe(true)
            if (operation === 'reject') {
                action.phase = 'failed'
                action.error = `Other tab rejected ${action.id}`
                const failed = { ...records.find(job => job.id === action.id)!, status: 'failed', error: action.error }
                const failureId = `external-${++clock}`
                const id = `${action.accountId}:${action.id}`
                eventValues.set(failurePrefix + id + ':' + failureId, JSON.stringify({ id, failureId, error: action.error }))
                entryValues.set(entryPrefix + id, JSON.stringify({ ...failed, status: 'pending', error: null }))
                saved = JSON.stringify(records.map(job => job.id === action.id ? failed : job))
                action.outcomeAt = savedAt
                coverage.tabStatusWrite = (coverage.tabStatusWrite ?? 0) + 1
            } else {
                markCompleted(action)
                saved = JSON.stringify(records.filter(job => job.id !== action.id))
                action.phase = 'settled'
                action.outcomeAt = ++clock
                coverage.tabCompletion = (coverage.tabCompletion ?? 0) + 1
            }
        }
        switchAccount()
        switchAccount()
        online = wasOnline
        start()
    }
    const staleOverwrite = (selectedId?: string) => {
        const action = selectedId ? actions.get(selectedId) : pick([...actions.values()].filter(item => item.phase === 'failed' && item.outcomeAt > savedAt && !overwritten.has(item.id)))
        if (!action || action.phase !== 'failed' || overwritten.has(action.id)) return
        const wasOnline = online
        online = false
        const id = nextId()
        const accountId = account === 'A' ? 'B' : 'A'
        actions.set(id, { id, accountId, phase: 'pending', sends: 0, allowance: 1, outcomeAt: 0 })
        const job: QueuedMutation = { id, accountId, leagueId: null, rowIds: [id], path: `/stale/${id}`, body: '{}', status: 'pending', error: null, createdAt: Date.now() }
        saved = JSON.stringify([...disk().filter(item => item.id !== action.id), job])
        if (!entryValues.has(entryPrefix + `${action.accountId}:${action.id}`)) overwritten.add(action.id)
        coverage.staleWriteApplied = (coverage.staleWriteApplied ?? 0) + 1
        switchAccount()
        switchAccount()
        online = wasOnline
        start()
    }
    const clockRollback = () => { wallNow -= 1000 + random(1000); coverage.clockRollbackApplied = (coverage.clockRollbackApplied ?? 0) + 1 }
    const corruptRecord = async (kind?: 'input' | 'failure' | 'retry' | 'completion', selectedId?: string) => {
        const id = selectedId ?? queue.pendingMutations()[0]?.id
        const action = id ? actions.get(id) : undefined
        if (!action || action.phase !== 'failed' || held.has(action.id) || action.accountId !== account) return
        const selected = kind ?? (['input', 'failure', 'retry', 'completion'] as const)[random(4)]
        const key = `${action.accountId}:${action.id}`
        const values = selected === 'input' ? entryValues : selected === 'completion' ? completionValues : eventValues
        const name = selected === 'input' ? entryPrefix + key : selected === 'completion' ? completionPrefix + key : (selected === 'failure' ? failurePrefix : retryPrefix) + key + ':corrupt'
        const previous = values.get(name)
        const sends = [...actions.values()].reduce((sum, item) => sum + item.sends, 0)
        values.set(name, '{invalid')
        const wasOnline = online
        online = true
        start()
        await flush()
        expect([...actions.values()].reduce((sum, item) => sum + item.sends, 0), String(seed)).toBe(sends)
        expect(queue.pendingMutations().find(job => job.id === action.id)?.status, String(seed)).toBe('failed')
        if (previous === undefined) values.delete(name)
        else values.set(name, previous)
        online = wasOnline
        coverage[`corrupt${selected}Applied`] = (coverage[`corrupt${selected}Applied`] ?? 0) + 1
    }
    const reload = async () => {
        const persisted = new Map(disk().map(job => [job.id, job]))
        const dirtyOutcome = [...actions.values()].some(action => action.phase === 'settled' && persisted.has(action.id)
            || action.phase === 'failed' && (persisted.get(action.id)?.status !== 'failed' || persisted.get(action.id)?.error !== action.error))
        const wasOnline = online
        online = false
        if (dirtyOutcome) {
            failures = 0
            coverage.reloadCheckpoint = (coverage.reloadCheckpoint ?? 0) + 1
            enqueue()
            await flush()
            check('reload checkpoint')
        }
        session.setSessionOwner(null)
        for (const [id] of held) { const action = actions.get(id)!; action.phase = 'pending'; action.allowance++ }
        held.clear()
        vi.resetModules()
        observedOrder = 0
        vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: storage }))
        await load()
        online = wasOnline
        start()
    }
    await load()
    await step('storageCleanupRace', () => { expect(cleanupRace()).toEqual({ retained: ['A', 'B'], sends: ['A', 'B'] }) })
    for (const boundary of ['initial check', 'persist read', 'persist write'] as const) {
        await step('storageEnqueueRace', () => {
            expect(enqueueRace(boundary)).toEqual({
                first: 'saved', second: 'This action completed in another tab. Refresh to see the result.', pending: 0,
                sends: ['A'], retry: 'This action belongs to an earlier session. Refresh before retrying.',
            })
        })
    }
    await step('liveRetryStorageGrowth', () => { expect(liveRetryStorageGrowth()).toEqual({ retries: 30, pending: 0, retryError: null }) })
    await step('expiredLegacyCompletion', () => { expect(expiredLegacyCompletion()).toEqual({ case: 'expired legacy completion', paths: ['/action', '/next'] }) })
    await step('rejectionDuringScan', () => { expect(rejectionDuringScan()).toEqual({ case: 'rejection during scan', statusBeforeSend: 'failed', sends: ['A'], caller: 'Rejected', pending: 1 }) })
    await step('retryStorageGrowth', () => { expect(retryStorageGrowth()).toEqual({ completed: 30, pending: 0, retainedFacts: 0, blocked: null }) })
    await step('forcedLegacyClear', () => { expect(legacyClear()).toEqual({ case: 'clear', pending: 0, sends: 0 }) })
    await step('fullQuotaReload', () => { expect(quotaReload()).toEqual({ case: 'quota', caller: 'saved', sends: 1 }) })
    await step('cachePressure', () => { expect(cachePressure(), String(seed)).toBe(64) })
    await step('completionAgeJump', () => { wallNow += 8 * 24 * 60 * 60 * 1000; expect(agedCompletion()).toEqual({ sends: 1, pending: 0 }) })
    await step('malformedStart', () => { expect(saved).toBe('{invalid'); expect(queue.mutationSnapshot()).toEqual([]) })
    let orderedFirst = '', orderedSecond = ''
    await step('enqueue', () => { orderedFirst = enqueue() })
    await step('clockRollback', clockRollback)
    await step('enqueue', () => { orderedSecond = enqueue() })
    await step('hold', () => { online = true; start(); expect(held.has(orderedFirst), String(seed)).toBe(true) })
    await step('accountReturnReadFault', async () => {
        online = false
        switchAccount()
        switchAccount()
        readFault = true
        online = true
        start()
        await flush()
        expect(held.has(orderedFirst), String(seed)).toBe(true)
        readFault = false
    })
    await step('success', () => release(orderedFirst, true))
    expect(held.has(orderedSecond), String(seed)).toBe(true)
    await step('transientCompletionWriteFault', () => { completionWriteFailures = 1; release(orderedSecond, true) })
    expect(completionValues.has(completionPrefix + `${account}:${orderedSecond}`), String(seed)).toBe(true)
    await step('offline', () => { online = false })
    let exiting = ''
    await step('enqueue', () => { exiting = enqueue() })
    await step('hold', () => { online = true; start() })
    await step('offlineCompletedExit', () => offlineExit(exiting))
    await step('hold', () => { online = true; start() })
    await step('offline', () => { online = false })
    await step('enqueue', () => { enqueue() })
    await step('switch', switchAccount)
    await step('enqueue', () => { enqueue() })
    await step('completionRace', completionRace)
    await step('switch', switchAccount)
    let external = ''
    await step('enqueue', () => { external = enqueue(); expect(() => JSON.parse(saved!)).not.toThrow() })
    await step('tabWrite', () => otherTab('reject', external))
    await step('tabComplete', () => otherTab('complete', external))
    let stale = ''
    await step('enqueue', () => { stale = enqueue() })
    await step('hold', () => { online = true; start() })
    await step('writeFault', () => { failures = 1 })
    await step('failure', () => release(stale, false))
    await step('tabComplete', () => otherTab('complete', stale))
    await step('tabEnqueue', () => otherTab('enqueue'))
    let successor = ''
    await step('enqueue', () => { successor = enqueue() })
    await step('success', () => release(successor, true))
    await step('offline', () => { online = false })
    let first = ''
    await step('enqueue', () => { first = enqueue() })
    await step('hold', () => { online = true; start() })
    await step('writeFault', () => { failures = 1 })
    await step('failure', () => release(first, false))
    await step('switch', switchAccount)
    await step('switch', switchAccount)
    for (const kind of ['input', 'failure', 'retry', 'completion'] as const) await step('corruptRecord', () => corruptRecord(kind, first))
    await step('staleOverwrite', () => staleOverwrite(first))
    await step('enqueue', () => { enqueue() })
    await step('switch', switchAccount)
    await step('enqueue', () => { enqueue() })
    await step('switch', switchAccount)
    await step('switch', switchAccount)
    await step('switch', switchAccount)
    await step('retry', () => retry(first))
    await step('success', () => release(first, true))
    const offlineSend = [...held.keys()].find(id => actions.get(id)!.accountId === account)
    expect(offlineSend, String(seed)).toBeDefined()
    await step('offline', () => { online = false })
    await step('failure', () => release(offlineSend, false))
    await step('hold', () => { online = true; start() })
    await step('reload', reload)
    for (let turn = 0; turn < 80; turn++) {
        const operation = random(19)
        if (operation < 2) await step('enqueue', () => { enqueue() })
        else if (operation === 2) await step('success', () => release(pick([...held.keys()]), true))
        else if (operation === 3) await step('failure', () => release(pick([...held.keys()]), false))
        else if (operation === 4) await step('retry', () => retry())
        else if (operation === 5) await step('writeFault', () => { failures = 1 + random(3) })
        else if (operation === 6) await step('switch', switchAccount)
        else if (operation === 7) await step('reload', reload)
        else if (operation === 8) await step('hold', () => { online = true; start() })
        else if (operation === 9) await step('offline', () => { online = false })
        else if (operation === 10) await step('tabWrite', () => otherTab('reject'))
        else if (operation === 11) await step('tabComplete', () => otherTab('complete'))
        else if (operation === 12) await step('tabEnqueue', () => otherTab('enqueue'))
        else if (operation === 13) await step('staleOverwrite', () => staleOverwrite())
        else if (operation === 14) await step('offlineCompletedExit', () => offlineExit())
        else if (operation === 15) await step('completionRace', completionRace)
        else if (operation === 16) await step('reconnect', () => { online = true; window.dispatchEvent(new Event('online')) })
        else if (operation === 17) await step('clockRollback', clockRollback)
        else await step('corruptRecord', () => corruptRecord())
    }
    failures = 0
    online = true
    start()
    await flush()
    for (let turn = 0; held.size && turn < serial + 1; turn++) await step('drain', () => release(held.keys().next().value, true))
    await step('reload', reload)
    online = false
    session.setSessionOwner(null)
    for (const operation of ['enqueue', 'success', 'failure', 'hold', 'retry', 'writeFault', 'switch', 'reload']) expect(coverage[operation], String(seed)).toBeGreaterThan(0)
    for (const outcome of ['writeFailure', 'sendStarted', 'sendSuccess', 'sendFailure', 'retryAccepted', 'offlineFailure', 'tabStatusWrite', 'tabCompletion', 'malformedStart', 'unsavedRejectionSwitch', 'externalEnqueueApplied', 'staleWriteApplied', 'completionRaceApplied', 'offlineCompletedExitApplied', 'clockRollbackApplied', 'accountReturnReadFault', 'readFailure', 'transientCompletionWriteFault', 'completionWriteFailure', 'corruptinputApplied', 'corruptfailureApplied', 'corruptretryApplied', 'corruptcompletionApplied']) expect(coverage[outcome] ?? 0, `${seed}: ${outcome}`).toBeGreaterThan(0)
    console.log(JSON.stringify({ seed, steps: stepCount, actions: actions.size, sends: [...actions.values()].reduce((sum, action) => sum + action.sends, 0), coverage }))
})
