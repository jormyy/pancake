import { requestId } from '@/lib/api-client'
import { sessionOwner, onSessionCachesCleared, sessionGeneration } from '@/lib/session-cache-registry'

export type QueuedMutation = { transport?: 'api' | 'rpc'; id: string; accountId: string; leagueId: string | null; rowIds: string[]; path: string; body: string; status: 'pending' | 'failed'; error: string | null; createdAt: number }
export type MutationInput = Pick<QueuedMutation, 'accountId' | 'leagueId' | 'rowIds' | 'path' | 'body' | 'transport'>
type Sender = (mutation: QueuedMutation) => Promise<unknown>
const key = 'pancake:offline-mutations:v1'
let jobs: QueuedMutation[] | undefined
const senders = new Map<string, Sender>()
let replay: Promise<void> | undefined
const listeners = new Set<() => void>()
const waiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

function read(): QueuedMutation[] {
    if (jobs) return jobs
    try {
        const saved: unknown = typeof window !== 'undefined' ? JSON.parse(window.localStorage.getItem(key) ?? '[]') : []
        jobs = Array.isArray(saved) ? saved.filter((job): job is QueuedMutation => job && typeof job.id === 'string' && typeof job.accountId === 'string' && typeof job.path === 'string' && typeof job.body === 'string' && Array.isArray(job.rowIds) && ['pending', 'failed'].includes(job.status)) : []
    } catch { jobs = [] }
    return jobs
}

function publish(): void {
    if (typeof window !== 'undefined') {
        try { window.localStorage.setItem(key, JSON.stringify(read())) } catch { throw new Error('Could not save your pending action. Keep this screen open and retry.') }
    }
    for (const listener of listeners) listener()
}

export function mutationSnapshot(): readonly QueuedMutation[] {
    return read()
}

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
    const current = read().find(job => job.id === selectedId && job.accountId === input.accountId)
    if (!current) jobs = [...read(), { ...input, id: selectedId, status: 'pending', error: null, createdAt: Date.now() }]
    try { publish() } catch (error) { jobs = read().filter(job => job.id !== selectedId); return Promise.reject(error) }
    const promise = new Promise<T>((resolve, reject) => waiters.set(selectedId, { resolve: value => resolve(value as T), reject }))
    void replayMutations()
    return promise
}

export function retryMutation(id: string): void {
    const job = read().find(item => item.id === id && item.accountId === sessionOwner())
    if (!job) return
    jobs = read().map(item => item === job ? { ...item, status: 'pending', error: null } : item)
    publish()
    void replayMutations()
}

export function replayMutations(): Promise<void> {
    if (replay) return replay
    if (!senders.size || typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve()
    const generation = sessionGeneration()
    const task = (async () => {
        while (typeof navigator === 'undefined' || navigator.onLine !== false) {
            const job = pendingMutations()[0]
            if (!job || job.status === 'failed' || generation !== sessionGeneration()) return
            try {
                const sender = senders.get(job.transport ?? 'api')
                if (!sender) return
                const value = await sender(job)
                if (generation !== sessionGeneration() || job.accountId !== sessionOwner()) return
                jobs = read().filter(item => item !== job)
                publish()
                waiters.get(job.id)?.resolve(value)
                waiters.delete(job.id)
            } catch (cause) {
                if (generation !== sessionGeneration()) return
                if (typeof navigator !== 'undefined' && navigator.onLine === false) return
                const error = cause instanceof Error ? cause.message : 'Could not send this action.'
                jobs = read().map(item => item === job ? { ...item, status: 'failed', error } : item)
                publish()
                waiters.get(job.id)?.reject(new Error(error))
                waiters.delete(job.id)
                return
            }
        }
    })()
    replay = task
    void task.finally(() => { if (replay === task) replay = undefined })
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
