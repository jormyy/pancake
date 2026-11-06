import { requestId } from '@/lib/api-client'
import { sessionOwner, onSessionCachesCleared, sessionGeneration } from '@/lib/session-cache-registry'

export type QueuedMutation = { transport?: 'api' | 'rpc'; id: string; accountId: string; leagueId: string | null; rowIds: string[]; path: string; body: string; status: 'pending' | 'failed'; error: string | null; createdAt: number }
export type MutationInput = Pick<QueuedMutation, 'accountId' | 'leagueId' | 'rowIds' | 'path' | 'body' | 'transport'>
type Sender = (mutation: QueuedMutation) => Promise<unknown>
const key = 'pancake:offline-mutations:v1'
const completionPrefix = 'pancake:offline-mutation-done:v1:'
const entryPrefix = 'pancake:offline-mutation:v1:'
const failurePrefix = 'pancake:offline-mutation-failure:v1:'
const retryPrefix = 'pancake:offline-mutation-retry:v1:'
const failures = new Map<string, Map<string, string>>()
const acknowledged = new Map<string, Set<string>>()
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

function observeFailure(id: string, failureId: string, error: string): void {
    if (!failures.has(id)) failures.set(id, new Map())
    failures.get(id)!.set(failureId, error)
}

function acknowledge(id: string, ids: string[]): void {
    if (!acknowledged.has(id)) acknowledged.set(id, new Set())
    for (const failureId of ids) acknowledged.get(id)!.add(failureId)
}

function read(): QueuedMutation[] {
    const entries = new Map<string, QueuedMutation>()
    if (typeof window !== 'undefined') try {
        const storage = window.localStorage
        for (let index = 0; index < storage.length; index++) {
            const name = storage.key(index)
            if (!name || ![entryPrefix, failurePrefix, retryPrefix].some(prefix => name.startsWith(prefix))) continue
            try {
                const value = JSON.parse(storage.getItem(name) ?? 'null')
                if (name.startsWith(entryPrefix) && isQueuedMutation(value) && name === entryPrefix + jobKey(value)) entries.set(jobKey(value), value)
                else if (name.startsWith(failurePrefix) && value && typeof value.id === 'string' && typeof value.failureId === 'string' && typeof value.error === 'string' && name === failurePrefix + value.id + ':' + value.failureId) observeFailure(value.id, value.failureId, value.error)
                else if (name.startsWith(retryPrefix) && value && typeof value.id === 'string' && Array.isArray(value.failures) && value.failures.every((id: unknown) => typeof id === 'string') && name.startsWith(retryPrefix + value.id + ':')) acknowledge(value.id, value.failures)
            } catch {}
        }
    } catch {}
    let saved: unknown
    try { saved = typeof window !== 'undefined' ? JSON.parse(window.localStorage.getItem(key) ?? '[]') : [] } catch { saved = undefined }
    const stored: QueuedMutation[] = Array.isArray(saved) ? saved.filter(isQueuedMutation) : []
    for (const job of [...stored.filter(job => !entries.has(jobKey(job))), ...entries.values()]) {
        if (job.status === 'failed') observeFailure(jobKey(job), 'legacy', job.error ?? 'Could not send this action.')
    }
    for (const job of stored) if (!entries.has(jobKey(job)) && !unsaved.has(jobKey(job)) && !completedJobs.has(jobKey(job))) unsaved.set(jobKey(job), jobs?.find(item => jobKey(item) === jobKey(job)) ?? job)
    const candidate = [...new Map([...(jobs ?? []).map(job => [jobKey(job), job] as const), ...stored.filter(job => !completedJobs.has(jobKey(job))).map(job => [jobKey(job), job] as const), ...[...entries].filter(([id]) => !completedJobs.has(id)), ...(jobs ?? []).map(job => [jobKey(job), job] as const), ...unsaved]).values()].filter((job): job is QueuedMutation => job !== null)
    const updated = candidate.map(job => {
        if (sending.has(job.id)) return job
        const open = [...failures.get(jobKey(job)) ?? []].filter(([id]) => !acknowledged.get(jobKey(job))?.has(id))
        const error = open.at(-1)?.[1] ?? null
        const status = open.length ? 'failed' : 'pending'
        if (job.status === status && job.error === error) return job
        const changed: QueuedMutation = { ...job, status, error }
        if (unsaved.get(jobKey(job))) unsaved.set(jobKey(job), changed)
        return changed
    })
    if (!jobs || updated.length !== jobs.length || updated.some((job, index) => job !== jobs![index])) jobs = updated
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

function publish(required = false, last?: string): void {
    if (typeof window !== 'undefined') {
        try {
            read()
            const changes = [...unsaved].sort(([left], [right]) => Number(left === last) - Number(right === last))
            for (const [id, job] of changes) {
                if (job === null) window.localStorage.removeItem(entryPrefix + id)
                else {
                    for (const [failureId, error] of failures.get(id) ?? []) window.localStorage.setItem(failurePrefix + id + ':' + failureId, JSON.stringify({ id, failureId, error }))
                    window.localStorage.setItem(entryPrefix + id, JSON.stringify({ ...job, status: 'pending', error: null }))
                }
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
    try { publish(true, jobKey(job)) } catch (error) {
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
    if ([...unsaved.values()].some(value => value !== null)) publish(true)
    const ids = [...failures.get(jobKey(job))?.keys() ?? []]
    if (typeof window !== 'undefined') try {
        window.localStorage.setItem(retryPrefix + jobKey(job) + ':' + requestId(), JSON.stringify({ id: jobKey(job), failures: ids }))
    } catch { throw new Error('Could not save your pending action. Keep this screen open and retry.') }
    acknowledge(jobKey(job), ids)
    read()
    publish()
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
            if ([...unsaved.values()].some(value => value !== null)) {
                try { publish(true) } catch { return }
                continue
            }
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
                observeFailure(jobKey(job), requestId(), error)
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
