import { requestId } from '@/lib/api-client'
import { sessionOwner, onSessionCachesCleared, sessionGeneration } from '@/lib/session-cache-registry'

export type QueuedMutation = { transport?: 'api' | 'rpc'; id: string; accountId: string; leagueId: string | null; rowIds: string[]; path: string; body: string; status: 'pending' | 'failed'; error: string | null; createdAt: number; order?: number }
export type MutationInput = Pick<QueuedMutation, 'accountId' | 'leagueId' | 'rowIds' | 'path' | 'body' | 'transport'>
type LegacySnapshot = { kind: 'available'; jobs: QueuedMutation[] } | { kind: 'unavailable' }
type DiskSnapshot = { kind: 'available' | 'unavailable'; legacy: LegacySnapshot; entries: Map<string, QueuedMutation>; missing: Set<string> }
type Sender = (mutation: QueuedMutation) => Promise<unknown>
const key = 'pancake:offline-mutations:v1'
const completionPrefix = 'pancake:offline-mutation-done:v1:'
const entryPrefix = 'pancake:offline-mutation:v1:'
const failurePrefix = 'pancake:offline-mutation-failure:v1:'
const retryPrefix = 'pancake:offline-mutation-retry:v1:'
const failures = new Map<string, Map<string, string>>()
const acknowledged = new Map<string, Set<string>>()
let fallbackFactSequence = 0
let highestOrder = 0
const completedJobs = new Set<string>()
const completionMaxAge = 7 * 24 * 60 * 60 * 1000
let jobs: QueuedMutation[] | undefined
let notifiedJobs: QueuedMutation[] | undefined
const senders = new Map<string, Sender>()
const sending = new Map<string, Promise<void>>()
const unsaved = new Map<string, QueuedMutation | null>()
const jobKey = (job: Pick<QueuedMutation, 'id' | 'accountId'>) => `${job.accountId}:${job.id}`
let replay: { generation: number; promise: Promise<void> } | undefined
const listeners = new Set<() => void>()
const waiters = new Map<string, { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void }>()

function completionState(id: string): 'completed' | 'unproven' | 'unavailable' {
    if (completedJobs.has(id)) return 'completed'
    try {
        const raw = typeof window !== 'undefined' ? window.localStorage.getItem(completionPrefix + id) : null
        if (raw === null) return 'unproven'
        const timestamp = Number(raw)
        if (!Number.isFinite(timestamp) || timestamp <= 0) return 'unavailable'
        const now = Date.now()
        const completed = Number.isFinite(timestamp) && timestamp > 0 && timestamp >= now - completionMaxAge
        if (completed) completedJobs.add(id)
        return completed ? 'completed' : 'unproven'
    } catch { return 'unavailable' }
}

function isCompleted(id: string): boolean {
    return completionState(id) === 'completed'
}

function rejectCompleted(job: QueuedMutation): void {
    waiters.get(job.id)?.reject(new Error('This action completed in another tab. Refresh to see the result.'))
    waiters.delete(job.id)
}

function isQueuedMutation(job: unknown): job is QueuedMutation {
    if (!job || typeof job !== 'object') return false
    const value = job as QueuedMutation
    return typeof value.id === 'string' && typeof value.accountId === 'string' && typeof value.path === 'string' && typeof value.body === 'string' && Array.isArray(value.rowIds) && ['pending', 'failed'].includes(value.status) && (value.order === undefined || Number.isSafeInteger(value.order) && value.order >= 0)
}

function withOrder(job: QueuedMutation, fallback: number): QueuedMutation {
    const order = job.order ?? (Number.isFinite(fallback) ? Math.max(0, fallback) : 0)
    highestOrder = Math.max(highestOrder, order)
    return job.order === order ? job : { ...job, order }
}

function factId(): string {
    try { return requestId() }
    catch { return `${Date.now()}:${++fallbackFactSequence}:${Math.random()}` }
}

function observeFailure(id: string, failureId: string, error: string): void {
    if (!failures.has(id)) failures.set(id, new Map())
    failures.get(id)!.set(failureId, error)
}

function acknowledge(id: string, ids: string[]): void {
    if (!acknowledged.has(id)) acknowledged.set(id, new Set())
    for (const failureId of ids) acknowledged.get(id)!.add(failureId)
}

function legacySnapshot(): LegacySnapshot {
    let raw: string | null
    try { raw = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null }
    catch { return { kind: 'unavailable' } }
    try {
        const saved: unknown = JSON.parse(raw ?? '[]')
        let order = 0
        const legacy = Array.isArray(saved) ? saved.filter(isQueuedMutation).map(job => {
            const ordered = withOrder(job, order + 1)
            order = Math.max(order, ordered.order!)
            return ordered
        }) : []
        return { kind: 'available', jobs: legacy }
    } catch { return { kind: 'available', jobs: [] } }
}

function diskSnapshot(): DiskSnapshot {
    const legacy = legacySnapshot()
    const snapshot: DiskSnapshot = { kind: legacy.kind, legacy, entries: new Map(), missing: new Set() }
    if (typeof window === 'undefined') return snapshot
    let storage: typeof window.localStorage
    try { storage = window.localStorage } catch { snapshot.kind = 'unavailable'; return snapshot }
    const corruptEntries = new Set<string>()
    const loadEntry = (name: string) => {
        const raw = storage.getItem(name)
        const id = name.slice(entryPrefix.length)
        if (raw === null) { snapshot.missing.add(id); return }
        snapshot.missing.add(id)
        corruptEntries.add(id)
        try {
            const value: unknown = JSON.parse(raw)
            if (isQueuedMutation(value) && name === entryPrefix + jobKey(value)) {
                const legacyOrder = legacy.kind === 'available' ? legacy.jobs.find(job => jobKey(job) === id)?.order : undefined
                snapshot.entries.set(id, withOrder(value, legacyOrder ?? value.createdAt))
                snapshot.missing.delete(id)
                corruptEntries.delete(id)
            }
        } catch {}
    }
    try {
        for (const name of Object.keys(storage)) {
            if (!name || ![entryPrefix, failurePrefix, retryPrefix].some(prefix => name.startsWith(prefix))) continue
            try {
                if (name.startsWith(entryPrefix)) { loadEntry(name); continue }
                const raw = storage.getItem(name)
                if (raw === null) continue
                try {
                    const value = JSON.parse(raw ?? 'null')
                    if (name.startsWith(failurePrefix) && value && typeof value.id === 'string' && typeof value.failureId === 'string' && typeof value.error === 'string' && name === failurePrefix + value.id + ':' + value.failureId) observeFailure(value.id, value.failureId, value.error)
                    else if (name.startsWith(retryPrefix) && value && typeof value.id === 'string' && Array.isArray(value.failures) && value.failures.every((id: unknown) => typeof id === 'string') && name.startsWith(retryPrefix + value.id + ':')) acknowledge(value.id, value.failures)
                    else snapshot.kind = 'unavailable'
                } catch { snapshot.kind = 'unavailable' }
            } catch { snapshot.kind = 'unavailable' }
        }
    } catch { snapshot.kind = 'unavailable' }
    const known = [...legacy.kind === 'available' ? legacy.jobs : [], ...jobs ?? [], ...[...unsaved.values()].filter((job): job is QueuedMutation => job !== null)]
    for (const id of new Set(known.map(jobKey))) if (!snapshot.entries.has(id)) {
        try { loadEntry(entryPrefix + id) } catch { snapshot.kind = 'unavailable' }
    }
    for (const id of corruptEntries) if (legacy.kind !== 'available' || !legacy.jobs.some(job => jobKey(job) === id)) snapshot.kind = 'unavailable'
    for (const id of new Set([...known.map(jobKey), ...snapshot.entries.keys(), ...unsaved.keys()])) if (completionState(id) === 'unavailable') snapshot.kind = 'unavailable'
    return snapshot
}

function read(snapshot = diskSnapshot()): QueuedMutation[] {
    const { legacy, entries, missing } = snapshot
    const stored = legacy.kind === 'available' ? legacy.jobs : []
    for (const job of [...stored.filter(job => missing.has(jobKey(job)) && !entries.has(jobKey(job)) || !failures.has(jobKey(job))), ...entries.values()]) {
        if (job.status === 'failed') observeFailure(jobKey(job), 'legacy', job.error ?? 'Could not send this action.')
    }
    for (const job of stored) if (missing.has(jobKey(job)) && !entries.has(jobKey(job)) && !unsaved.has(jobKey(job)) && !completedJobs.has(jobKey(job))) unsaved.set(jobKey(job), jobs?.find(item => jobKey(item) === jobKey(job)) ?? job)
    const candidate = [...new Map([...(jobs ?? []).map(job => [jobKey(job), job] as const), ...stored.filter(job => !completedJobs.has(jobKey(job))).map(job => [jobKey(job), job] as const), ...[...entries].filter(([id]) => !completedJobs.has(id)), ...(jobs ?? []).map(job => [jobKey(job), job] as const), ...unsaved]).values()].filter((job): job is QueuedMutation => job !== null).sort((left, right) => (left.order ?? left.createdAt) - (right.order ?? right.createdAt) || (jobKey(left) < jobKey(right) ? -1 : jobKey(left) > jobKey(right) ? 1 : 0))
    const updated = candidate.map(job => {
        if (sending.has(job.id) || snapshot.kind === 'unavailable' && !failures.has(jobKey(job))) return job
        const open = [...failures.get(jobKey(job)) ?? []].filter(([id]) => !acknowledged.get(jobKey(job))?.has(id))
        const error = open.at(-1)?.[1] ?? null
        const status = open.length ? 'failed' : 'pending'
        if (job.status === status && job.error === error) return job
        const changed: QueuedMutation = { ...job, status, error }
        if (unsaved.get(jobKey(job))) unsaved.set(jobKey(job), changed)
        return changed
    })
    if (!jobs || updated.length !== jobs.length || updated.some((job, index) => job !== jobs![index])) jobs = updated
    const completed = new Set([...new Set([...jobs.map(jobKey), ...unsaved.keys()])].filter(id => completedJobs.has(id)))
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
            const snapshot = diskSnapshot()
            read(snapshot)
            const changes = [...unsaved].sort(([left], [right]) => Number(left === last) - Number(right === last))
            for (const [id, job] of changes) {
                if (job === null) window.localStorage.removeItem(entryPrefix + id)
                else {
                    for (const [failureId, error] of failures.get(id) ?? []) window.localStorage.setItem(failurePrefix + id + ':' + failureId, JSON.stringify({ id, failureId, error }))
                    window.localStorage.setItem(entryPrefix + id, JSON.stringify({ ...job, status: 'pending', error: null }))
                }
            }
            unsaved.clear()
            if (snapshot.kind === 'available') try { window.localStorage.setItem(key, JSON.stringify(read(snapshot))) }
            catch (error) {
                console.error('Could not save the pending action list.', error)
                if (!read(snapshot).length) try { window.localStorage.removeItem(key) } catch {}
            }
        } catch (error) {
            if (required) throw new Error('Could not save your pending action. Keep this screen open and retry.')
            console.error('Could not save the result of this action.', error)
        }
    }
    notify()
}

function notify(): void {
    if (notifiedJobs === jobs) return
    notifiedJobs = jobs
    for (const listener of listeners) {
        try { listener() } catch (error) { console.error('Could not update pending actions.', error) }
    }
}

function failMutation(job: QueuedMutation, error: string, generation: number): void {
    observeFailure(jobKey(job), factId(), error)
    const failed: QueuedMutation = { ...job, status: 'failed', error }
    unsaved.set(jobKey(job), failed)
    jobs = read().map(item => jobKey(item) === jobKey(job) ? failed : item)
    publish()
    if (generation === sessionGeneration() && job.accountId === sessionOwner()) {
        waiters.get(job.id)?.reject(new Error(error))
        waiters.delete(job.id)
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
        ?? withOrder({ ...input, id: selectedId, status: 'pending', error: null, createdAt: Date.now(), order: Math.max(Date.now(), highestOrder + 1) }, 0)
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
        window.localStorage.setItem(retryPrefix + jobKey(job) + ':' + factId(), JSON.stringify({ id: jobKey(job), failures: ids }))
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
            let snapshot = diskSnapshot()
            if (snapshot.kind === 'unavailable') {
                await Promise.resolve()
                if (generation !== sessionGeneration() || typeof navigator !== 'undefined' && navigator.onLine === false) return
                snapshot = diskSnapshot()
                if (snapshot.kind === 'unavailable') {
                    const blocked = read(snapshot).find(item => item.accountId === sessionOwner())
                    if (blocked?.status === 'pending' && !sending.has(blocked.id)) failMutation(blocked, 'Could not read your pending actions. Refresh and retry.', generation)
                    return
                }
            }
            const job = read(snapshot).find(item => item.accountId === sessionOwner())
            if (!job || job.status === 'failed') { if ([...unsaved.values()].includes(null)) publish(); return }
            if (typeof window !== 'undefined' && [...unsaved.values()].some(value => value !== null)) {
                try { publish(true) } catch (cause) {
                    failMutation(job, cause instanceof Error ? cause.message : 'Could not save your pending actions. Refresh and retry.', generation)
                    return
                }
                continue
            }
            const active = sending.get(job.id)
            if (active) { await active; continue }
            const sender = senders.get(job.transport ?? 'api')
            if (!sender) return
            let completion = completionState(jobKey(job))
            if (completion === 'unavailable') {
                await Promise.resolve()
                if (generation !== sessionGeneration() || typeof navigator !== 'undefined' && navigator.onLine === false) return
                completion = completionState(jobKey(job))
            }
            if (completion === 'unavailable') {
                failMutation(job, 'Could not read your pending actions. Refresh and retry.', generation)
                return
            }
            if (completion === 'completed') {
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
                failMutation(job, error, generation)
            } finally {
                sending.delete(job.id)
                if (current() && isCompleted(jobKey(job))) rejectCompleted(job)
                finish()
            }
        }
    })()
    replay = { generation, promise: task }
    void task.finally(() => {
        if (replay?.promise !== task) return
        replay = undefined
        if (generation !== sessionGeneration()) return
        const next = pendingMutations()[0]
        notify()
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return
        if (next?.status === 'pending' && !sending.has(next.id) && senders.has(next.transport ?? 'api')) void replayMutations()
    })
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
