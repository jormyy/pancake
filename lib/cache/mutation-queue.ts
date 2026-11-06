import { requestId } from '@/lib/api-client'
import { sessionOwner, onSessionCachesCleared, sessionGeneration } from '@/lib/session-cache-registry'

export type QueuedMutation = { transport?: 'api' | 'rpc'; id: string; accountId: string; leagueId: string | null; rowIds: string[]; path: string; body: string; status: 'pending' | 'failed'; error: string | null; createdAt: number }
export type MutationInput = Pick<QueuedMutation, 'accountId' | 'leagueId' | 'rowIds' | 'path' | 'body' | 'transport'>
type Sender = (mutation: QueuedMutation) => Promise<unknown>
const key = 'pancake:offline-mutations:v1'
const completionPrefix = 'pancake:offline-mutation-done:v1:'
const entryPrefix = 'pancake:offline-mutation:v1:'
const completedJobs = new Set<string>()
const completionMaxAge = 7 * 24 * 60 * 60 * 1000
let jobs: QueuedMutation[] | undefined
const senders = new Map<string, Sender>()
const sending = new Map<string, Promise<void>>()
const unsaved = new Map<string, QueuedMutation | null>()
const jobKey = (job: Pick<QueuedMutation, 'id' | 'accountId'>) => `${job.accountId}:${job.id}`
let replay: { generation: number; promise: Promise<void> } | undefined
const listeners = new Set<() => void>()
const waiters = new Map<string, { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void }>()

function isCompleted(id: string): boolean {
    if (completedJobs.has(id)) return true
    try {
        const timestamp = typeof window !== 'undefined' ? Number(window.localStorage.getItem(completionPrefix + id)) : 0
        const now = Date.now()
        const completed = Number.isFinite(timestamp) && timestamp > 0 && timestamp >= now - completionMaxAge
        if (completed) completedJobs.add(id)
        return completed
    } catch { return false }
}

function rejectCompleted(job: QueuedMutation): void {
    waiters.get(job.id)?.reject(new Error('This action completed in another tab. Refresh to see the result.'))
    waiters.delete(job.id)
}

function isQueuedMutation(job: unknown): job is QueuedMutation {
    if (!job || typeof job !== 'object') return false
    const value = job as QueuedMutation
    return typeof value.id === 'string' && typeof value.accountId === 'string' && typeof value.path === 'string' && typeof value.body === 'string' && Array.isArray(value.rowIds) && ['pending', 'failed'].includes(value.status)
}

function read(): QueuedMutation[] {
    const entries = new Map<string, QueuedMutation>()
    if (typeof window !== 'undefined') try {
        const storage = window.localStorage
        for (let index = 0; index < storage.length; index++) {
            const name = storage.key(index)
            if (!name?.startsWith(entryPrefix)) continue
            try {
                const value: unknown = JSON.parse(storage.getItem(name) ?? 'null')
                if (isQueuedMutation(value) && name === entryPrefix + jobKey(value)) entries.set(jobKey(value), value)
            } catch {}
        }
    } catch {}
    if (!jobs) {
        let saved: unknown
        try { saved = typeof window !== 'undefined' ? JSON.parse(window.localStorage.getItem(key) ?? '[]') : [] } catch { saved = undefined }
        const stored = Array.isArray(saved) ? saved.filter(isQueuedMutation) : []
        for (const job of stored) if (!entries.has(jobKey(job)) && !unsaved.has(jobKey(job))) unsaved.set(jobKey(job), job)
        jobs = [...new Map([...stored.map(job => [jobKey(job), job] as const), ...entries, ...unsaved]).values()].filter((job): job is QueuedMutation => job !== null)
    } else {
        const updated = jobs.map(job => {
            const saved = entries.get(jobKey(job))
            if (job.status !== 'pending' || saved?.status !== 'failed' || sending.has(job.id) || unsaved.get(jobKey(job)) === null) return job
            if (unsaved.has(jobKey(job))) unsaved.set(jobKey(job), saved)
            return saved
        })
        if (updated.some((job, index) => job !== jobs![index])) jobs = updated
        const known = new Set(jobs.map(jobKey))
        const added = [...entries.values()].filter(job => !known.has(jobKey(job)) && !unsaved.has(jobKey(job)))
        if (added.length) jobs = [...jobs, ...added]
    }
    const completed = new Set([...new Set([...jobs.map(jobKey), ...unsaved.keys()])].filter(isCompleted))
    for (const id of completed) unsaved.set(id, null)
    const active = jobs.filter(job => !completed.has(jobKey(job)) && unsaved.get(jobKey(job)) !== null)
    for (const job of jobs) if (completed.has(jobKey(job)) && job.accountId === sessionOwner()) rejectCompleted(job)
    if (active.length !== jobs.length) jobs = active
    for (const job of jobs) if (job.status === 'failed' && !sending.has(job.id) && job.accountId === sessionOwner()) {
        waiters.get(job.id)?.reject(new Error(job.error ?? 'Could not send this action.'))
        waiters.delete(job.id)
    }
    return jobs
}

function complete(job: QueuedMutation): void {
    unsaved.set(jobKey(job), null)
    jobs = read().filter(item => jobKey(item) !== jobKey(job))
    completedJobs.add(jobKey(job))
    if (typeof window !== 'undefined') {
        try { window.localStorage.setItem(completionPrefix + jobKey(job), String(Date.now())) }
        catch (error) { console.error('Could not record action completion.', error) }
    }
    publish()
}

function publish(required = false): void {
    if (typeof window !== 'undefined') {
        try {
            for (const [id, job] of unsaved) {
                if (job === null) window.localStorage.removeItem(entryPrefix + id)
                else window.localStorage.setItem(entryPrefix + id, JSON.stringify(job))
            }
            unsaved.clear()
            try { window.localStorage.setItem(key, JSON.stringify(read())) }
            catch (error) {
                console.error('Could not save the pending action list.', error)
                if (!read().length) try { window.localStorage.removeItem(key) } catch {}
            }
        } catch (error) {
            if (required) throw new Error('Could not save your pending action. Keep this screen open and retry.')
            console.error('Could not save the result of this action.', error)
        }
    }
    for (const listener of listeners) {
        try { listener() } catch (error) { console.error('Could not update pending actions.', error) }
    }
}

export const mutationSnapshot: () => readonly QueuedMutation[] = read

export function pendingMutations(accountId = sessionOwner()): QueuedMutation[] {
    return read().filter(job => job.accountId === accountId)
}

export function subscribeMutations(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

export function configureMutationReplay(send: Sender, transport: 'api' | 'rpc' = 'api'): void {
    senders.set(transport, send)
    void replayMutations()
}

export function queueMutation<T>(input: MutationInput, id?: string): Promise<T> {
    const selectedId = requestId(id)
    if (input.accountId !== sessionOwner()) return Promise.reject(new Error('Your account changed. Please retry.'))
    const waiting = waiters.get(selectedId)
    if (waiting) { void replayMutations(); return waiting.promise as Promise<T> }
    if (sending.has(selectedId) || unsaved.get(jobKey({ accountId: input.accountId, id: selectedId })) === null || isCompleted(jobKey({ accountId: input.accountId, id: selectedId }))) return Promise.reject(new Error('This action belongs to an earlier session. Refresh before retrying.'))
    let resolve!: (value: unknown) => void
    let reject!: (error: Error) => void
    const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail })
    waiters.set(selectedId, { promise, resolve, reject })
    const previous = read()
    const job: QueuedMutation = previous.find(item => item.id === selectedId && item.accountId === input.accountId)
        ?? { ...input, id: selectedId, status: 'pending', error: null, createdAt: Date.now() }
    if (!previous.includes(job)) jobs = [...previous, job]
    const previousUnsaved = unsaved.get(jobKey(job))
    unsaved.set(jobKey(job), job)
    try { publish(true) } catch (error) {
        jobs = previous
        if (previousUnsaved === undefined) unsaved.delete(jobKey(job))
        else unsaved.set(jobKey(job), previousUnsaved)
        waiters.delete(selectedId)
        reject(error as Error)
        return promise as Promise<T>
    }
    read()
    void replayMutations()
    return promise as Promise<T>
}

export function retryMutation(id: string): void {
    const job = read().find(item => item.id === id && item.accountId === sessionOwner())
    if (!job || job.status !== 'failed') return
    const previous = read()
    const retry: QueuedMutation = { ...job, status: 'pending', error: null }
    jobs = previous.map(item => item === job ? retry : item)
    const previousUnsaved = unsaved.get(jobKey(job))
    unsaved.set(jobKey(job), retry)
    try { publish(true) } catch (error) {
        jobs = previous
        if (previousUnsaved === undefined) unsaved.delete(jobKey(job))
        else unsaved.set(jobKey(job), previousUnsaved)
        throw error
    }
    void replayMutations()
}

export function replayMutations(): Promise<void> {
    const generation = sessionGeneration()
    if (replay?.generation === generation) return replay.promise
    if (!senders.size || typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve()
    const task = (async () => {
        while (typeof navigator === 'undefined' || navigator.onLine !== false) {
            if (generation !== sessionGeneration()) return
            const job = pendingMutations()[0]
            if (!job || job.status === 'failed') { if ([...unsaved.values()].includes(null)) publish(); return }
            const active = sending.get(job.id)
            if (active) { await active; continue }
            const sender = senders.get(job.transport ?? 'api')
            if (!sender) return
            if (isCompleted(jobKey(job))) {
                unsaved.set(jobKey(job), null)
                jobs = jobs?.filter(item => jobKey(item) !== jobKey(job))
                rejectCompleted(job)
                continue
            }
            const current = () => generation === sessionGeneration() && job.accountId === sessionOwner()
            let finish!: () => void
            sending.set(job.id, new Promise<void>(resolve => { finish = resolve }))
            try {
                const value = await sender(job)
                if (current() && isCompleted(jobKey(job))) rejectCompleted(job)
                complete(job)
                if (current()) { waiters.get(job.id)?.resolve(value); waiters.delete(job.id) }
            } catch (cause) {
                if (current() && isCompleted(jobKey(job))) rejectCompleted(job)
                if (typeof navigator !== 'undefined' && navigator.onLine === false) return
                const error = cause instanceof Error ? cause.message : 'Could not send this action.'
                const failed: QueuedMutation = { ...job, status: 'failed', error }
                unsaved.set(jobKey(job), failed)
                jobs = read().map(item => jobKey(item) === jobKey(job) ? failed : item)
                publish()
                if (current()) { waiters.get(job.id)?.reject(new Error(error)); waiters.delete(job.id) }
            } finally {
                sending.delete(job.id)
                if (current() && isCompleted(jobKey(job))) rejectCompleted(job)
                finish()
            }
        }
    })()
    replay = { generation, promise: task }
    void task.finally(() => { if (replay?.promise === task) replay = undefined })
    return task
}

if (typeof window !== 'undefined') window.addEventListener('online', () => { void replayMutations() })
onSessionCachesCleared(() => {
    for (const waiter of waiters.values()) waiter.reject(new Error('Your account changed. Please retry.'))
    waiters.clear()
    jobs = undefined
    for (const listener of listeners) listener()
})

export function mutationRowIds(value: unknown): string[] {
    if (!value || typeof value !== 'object') return []
    const ids = new Set<string>()
    for (const [key, item] of Object.entries(value)) {
        if (/(?:Id|Ids|_id|_ids)$/.test(key)) {
            if (typeof item === 'string') ids.add(item)
            else if (Array.isArray(item)) for (const id of item) if (typeof id === 'string') ids.add(id)
        }
        if (item && typeof item === 'object') for (const id of mutationRowIds(item)) ids.add(id)
    }
    return [...ids]
}
