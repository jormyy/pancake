import { requestId } from '@/lib/api-client'
import { sessionOwner, onSessionCachesCleared, sessionGeneration } from '@/lib/session-cache-registry'

export type QueuedMutation = { transport?: 'api' | 'rpc'; id: string; accountId: string; leagueId: string | null; rowIds: string[]; path: string; body: string; status: 'pending' | 'failed'; error: string | null; createdAt: number }
export type MutationInput = Pick<QueuedMutation, 'accountId' | 'leagueId' | 'rowIds' | 'path' | 'body' | 'transport'>
type Sender = (mutation: QueuedMutation) => Promise<unknown>
const key = 'pancake:offline-mutations:v1'
const completionKey = 'pancake:offline-mutation-completions:v1'
let jobs: QueuedMutation[] | undefined
const senders = new Map<string, Sender>()
const sending = new Map<string, Promise<void>>()
const unsaved = new Map<string, QueuedMutation | null>()
const jobKey = (job: Pick<QueuedMutation, 'id' | 'accountId'>) => `${job.accountId}:${job.id}`
let replay: { generation: number; promise: Promise<void> } | undefined
const listeners = new Set<() => void>()
const waiters = new Map<string, { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void }>()

function completions(): string[] {
    try {
        const saved: unknown = typeof window !== 'undefined' ? JSON.parse(window.localStorage.getItem(completionKey) ?? '[]') : []
        return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string').slice(-200) : []
    } catch { return [] }
}

function read(): QueuedMutation[] {
    const completed = new Set(completions())
    for (const id of completed) if (unsaved.get(id)) unsaved.delete(id)
    if (!jobs) {
        let saved: unknown
        try { saved = typeof window !== 'undefined' ? JSON.parse(window.localStorage.getItem(key) ?? '[]') : [] } catch { saved = undefined }
        const stored = Array.isArray(saved) ? saved.filter((job): job is QueuedMutation => job && typeof job.id === 'string' && typeof job.accountId === 'string' && typeof job.path === 'string' && typeof job.body === 'string' && Array.isArray(job.rowIds) && ['pending', 'failed'].includes(job.status)) : []
        jobs = [...new Map([...stored.map(job => [jobKey(job), job] as const), ...unsaved]).values()].filter((job): job is QueuedMutation => job !== null)
    }
    const active = jobs.filter(job => !completed.has(jobKey(job)))
    for (const job of jobs) if (completed.has(jobKey(job)) && !sending.has(job.id) && job.accountId === sessionOwner()) {
        waiters.get(job.id)?.reject(new Error('This action completed in another tab. Refresh to see the result.'))
        waiters.delete(job.id)
    }
    if (active.length !== jobs.length) jobs = active
    return jobs
}

function complete(job: QueuedMutation): void {
    unsaved.set(jobKey(job), null)
    jobs = read().filter(item => jobKey(item) !== jobKey(job))
    publish()
    try {
        if (typeof window !== 'undefined') window.localStorage.setItem(completionKey, JSON.stringify([...completions().filter(id => id !== jobKey(job)), jobKey(job)].slice(-200)))
    } catch (error) { console.error('Could not record action completion.', error) }
}

function publish(required = false): void {
    if (typeof window !== 'undefined') {
        try {
            window.localStorage.setItem(key, JSON.stringify(read()))
            unsaved.clear()
        } catch (error) {
            if (required) throw new Error('Could not save your pending action. Keep this screen open and retry.')
            console.error('Could not save the result of this action.', error)
            if (!read().length) try { window.localStorage.removeItem(key); unsaved.clear() } catch {}
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
    if (sending.has(selectedId) || unsaved.get(jobKey({ accountId: input.accountId, id: selectedId })) === null || completions().includes(jobKey({ accountId: input.accountId, id: selectedId }))) return Promise.reject(new Error('This action belongs to an earlier session. Refresh before retrying.'))
    const previous = read()
    const job: QueuedMutation = previous.find(item => item.id === selectedId && item.accountId === input.accountId)
        ?? { ...input, id: selectedId, status: 'pending', error: null, createdAt: Date.now() }
    if (!previous.includes(job)) jobs = [...previous, job]
    try { publish(true) } catch (error) { jobs = previous; return Promise.reject(error) }
    let resolve!: (value: unknown) => void
    let reject!: (error: Error) => void
    const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail })
    waiters.set(selectedId, { promise, resolve, reject })
    void replayMutations()
    return promise as Promise<T>
}

export function discardMutation(id: string): void {
    const job = read().find(item => item.id === id && item.accountId === sessionOwner())
    if (!job || sending.has(id)) return
    complete(job)
    waiters.get(id)?.reject(new Error('This action was discarded.'))
    waiters.delete(id)
}

export function retryMutation(id: string): void {
    const job = read().find(item => item.id === id && item.accountId === sessionOwner())
    if (!job || job.status !== 'failed') return
    const previous = read()
    const retry: QueuedMutation = { ...job, status: 'pending', error: null }
    jobs = previous.map(item => item === job ? retry : item)
    try { publish(true) } catch (error) { jobs = previous; throw error }
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
            const current = () => generation === sessionGeneration() && job.accountId === sessionOwner()
            let finish!: () => void
            sending.set(job.id, new Promise<void>(resolve => { finish = resolve }))
            try {
                const value = await sender(job)
                complete(job)
                if (current()) { waiters.get(job.id)?.resolve(value); waiters.delete(job.id) }
            } catch (cause) {
                if (typeof navigator !== 'undefined' && navigator.onLine === false) return
                const error = cause instanceof Error ? cause.message : 'Could not send this action.'
                const failed: QueuedMutation = { ...job, status: 'failed', error }
                unsaved.set(jobKey(job), failed)
                jobs = read().map(item => jobKey(item) === jobKey(job) ? failed : item)
                publish()
                if (current()) { waiters.get(job.id)?.reject(new Error(error)); waiters.delete(job.id) }
            } finally { sending.delete(job.id); finish() }
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
