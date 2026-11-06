import { afterEach, expect, it, vi } from 'vitest'
import type { QueuedMutation } from '@/lib/cache/mutation-queue'

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
    let saved: string | undefined
    let online = false
    let failures = 0
    let serial = 0
    let clock = 0
    let savedAt = 0
    let account = 'A'
    let stepCount = 0
    const disk = (): QueuedMutation[] => JSON.parse(saved ?? '[]')
    const storage = {
        getItem: () => saved ?? null,
        setItem: (_key: string, value: string) => {
            if (failures > 0) { failures--; coverage.writeFailure = (coverage.writeFailure ?? 0) + 1; throw new Error('Injected storage failure') }
            saved = value
            savedAt = ++clock
        },
        removeItem: () => {
            if (failures > 0) { failures--; coverage.writeFailure = (coverage.writeFailure ?? 0) + 1; throw new Error('Injected removal failure') }
            saved = undefined
            savedAt = ++clock
        },
    }
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
                expect(persisted.has(action.id), context).toBe(true)
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
    const enqueue = () => {
        const id = `${seed.toString(16).padStart(8, '0')}-0000-4000-8000-${(++serial).toString(16).padStart(12, '0')}`
        const action: Action = { id, accountId: account, phase: 'pending', sends: 0, allowance: 1, outcomeAt: 0 }
        actions.set(id, action)
        void queue.queueMutation({ accountId: account, leagueId: null, rowIds: [id], path: `/sequence/${id}`, body: '{}' }, id).catch(() => {})
        if (!queue.mutationSnapshot().some(job => job.id === id)) actions.delete(id)
        return id
    }
    const release = (id: string | undefined, success: boolean) => {
        if (!id) return
        const control = held.get(id)
        if (!control) return
        const action = actions.get(id)!
        held.delete(id)
        coverage[success ? 'sendSuccess' : 'sendFailure'] = (coverage[success ? 'sendSuccess' : 'sendFailure'] ?? 0) + 1
        action.phase = success ? 'settled' : 'failed'
        action.error = success ? undefined : `Rejected ${id}`
        action.outcomeAt = ++clock
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
    const switchAccount = () => { account = account === 'A' ? 'B' : 'A'; session.setSessionOwner(account); start() }
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
        vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: storage }))
        await load()
        online = wasOnline
        start()
    }
    await load()
    let first = ''
    await step('enqueue', () => { first = enqueue() })
    await step('hold', () => { online = true; start() })
    await step('writeFault', () => { failures = 1 })
    await step('failure', () => release(first, false))
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
        const operation = random(10)
        if (operation < 2) await step('enqueue', () => { enqueue() })
        else if (operation === 2) await step('success', () => release(pick([...held.keys()]), true))
        else if (operation === 3) await step('failure', () => release(pick([...held.keys()]), false))
        else if (operation === 4) await step('retry', () => retry())
        else if (operation === 5) await step('writeFault', () => { failures = 1 + random(3) })
        else if (operation === 6) await step('switch', switchAccount)
        else if (operation === 7) await step('reload', reload)
        else if (operation === 8) await step('hold', () => { online = true; start() })
        else await step('offline', () => { online = false })
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
    for (const outcome of ['writeFailure', 'sendStarted', 'sendSuccess', 'sendFailure', 'retryAccepted']) expect(coverage[outcome], String(seed)).toBeGreaterThan(0)
    console.log(JSON.stringify({ seed, steps: stepCount, actions: actions.size, sends: [...actions.values()].reduce((sum, action) => sum + action.sends, 0), coverage }))
})
