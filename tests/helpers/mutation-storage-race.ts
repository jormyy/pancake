import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { createContext, runInContext, type Context } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import type { QueuedMutation } from '@/lib/cache/mutation-queue'

const queueKey = 'pancake:offline-mutations:v1'
export const completionPrefix = 'pancake:offline-mutation-done:v1:'
export const records: QueuedMutation[] = ['A', 'B'].map((accountId, index) => ({
    id: `10000000-0000-4000-8000-00000000000${index + 1}`, accountId, leagueId: null,
    rowIds: [], path: '/action', body: '{}', status: 'pending', error: null, createdAt: 0,
}))
export const start = 'navigator.onLine=true;queue.replayMutations()'
export const enqueue = 'queue.queueMutation(input,input.id).then(v=>result=v,e=>result=e.message)'

export function storageRace(initial: QueuedMutation[] = []) {
    const sources = Object.fromEntries(['api-client', 'session-cache-registry', 'cache/mutation-queue'].map(name => [
        `@/lib/${name}`, transpileModule(readFileSync(`lib/${name}.ts`, 'utf8'), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
        }).outputText,
    ]))
    const values = new Map([[queueKey, JSON.stringify(initial)]])
    const sends: string[] = []
    const state = {
        values, sends, now: 2_000_000_000_000,
        onEnumerate: undefined as (() => void) | undefined,
        onGet: undefined as ((key: string, value: string | null) => void) | undefined,
        onSet: undefined as ((key: string, value: string) => void) | undefined,
        onBeforeSet: undefined as ((key: string, value: string) => void) | undefined,
        onRemove: undefined as ((key: string) => void) | undefined,
    }
    const storage = new Proxy({
        get length() { return values.size },
        key: (index: number) => [...values.keys()][index] ?? null,
        getItem: (key: string) => { const value = values.get(key) ?? null; state.onGet?.(key, value); return value },
        setItem: (key: string, value: string) => { state.onBeforeSet?.(key, value); values.set(key, value); state.onSet?.(key, value) },
        removeItem: (key: string) => { state.onRemove?.(key); values.delete(key) },
    }, {
        ownKeys: () => { state.onEnumerate?.(); return [...values.keys()] },
        getOwnPropertyDescriptor: (target, name) => typeof name === 'string' && values.has(name)
            ? { configurable: true, enumerable: true, writable: true, value: undefined }
            : Reflect.getOwnPropertyDescriptor(target, name),
    })
    const run = (tab: Context, code: string) => runInContext(code, tab)
    const tab = (owner: string) => {
        const context = createContext({
            console, crypto: webcrypto, window: { localStorage: storage, addEventListener() {} }, navigator: { onLine: false },
            input: records.find(job => job.accountId === owner), record: () => sends.push(owner), now: () => state.now,
        }, { microtaskMode: 'afterEvaluate' })
        run(context, 'Date.now=now')
        const cache = new Map<string, { exports: Record<string, (...args: unknown[]) => unknown> }>()
        const load = (name: string): Record<string, (...args: unknown[]) => unknown> => {
            if (cache.has(name)) return cache.get(name)!.exports
            const module = { exports: {} }
            cache.set(name, module)
            run(context, `(function(require,module,exports){${sources[name]}\n})`)(load, module, module.exports)
            return module.exports
        }
        load('@/lib/session-cache-registry').setSessionOwner(owner)
        context.session = load('@/lib/session-cache-registry')
        context.queue = load('@/lib/cache/mutation-queue')
        run(context, 'queue.mutationSnapshot();queue.configureMutationReplay(async()=>{record();return "saved"});result="pending"')
        return context
    }
    return Object.assign(state, { run, tab })
}

export function cleanupRace() {
    const race = storageRace(records)
    const a = race.tab('A'), b = race.tab('B'), stale = race.tab('B')
    race.onSet = key => {
        if (key !== completionPrefix + 'A:' + records[0].id) return
        race.onSet = undefined
        race.now++
        race.run(b, start)
    }
    race.run(a, start)
    const retained = [...race.values.keys()].filter(key => key.startsWith(completionPrefix)).map(key => key.slice(completionPrefix.length, completionPrefix.length + 1))
    race.run(stale, start)
    return { retained, sends: race.sends }
}

export function enqueueRace(boundary: 'initial check' | 'persist read' | 'persist write') {
    const race = storageRace()
    const first = race.tab('A'), second = race.tab('A')
    race.run(first, enqueue)
    let reads = 0
    const complete = () => {
        race.onGet = undefined
        race.onSet = undefined
        race.run(first, start)
    }
    if (boundary === 'persist write') race.onSet = name => { if (name === 'pancake:offline-mutations:v1') complete() }
    else race.onGet = name => {
        if (name === completionPrefix + 'A:' + records[0].id && ++reads === (boundary === 'initial check' ? 1 : 2)) complete()
    }
    race.run(second, enqueue + ';' + start)
    const result = { first: first.result, second: second.result, pending: race.run(second, 'queue.pendingMutations().length'), sends: [...race.sends] }
    race.run(second, 'queue.queueMutation(input,input.id).then(()=>result="unexpected",e=>result=e.message)')
    return { ...result, retry: second.result }
}

export function persistentCache(tab: Context) {
    const module = { exports: {} as typeof import('@/lib/persistent-cache') }
    const source = transpileModule(readFileSync('lib/persistent-cache.ts', 'utf8'), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    }).outputText
    runInContext(`(function(require,module,exports){${source}\n})`, tab)(
        (name: string) => name === 'react-native' ? { Platform: { OS: 'web' } } : tab.session,
        module, module.exports,
    )
    return module.exports
}

export function cachePressure() {
    const race = storageRace(), tab = race.tab('A')
    for (let index = 1; index <= 64; index++) {
        tab.input = { ...records[0], id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}` }
        race.run(tab, enqueue)
    }
    persistentCache(tab).writePersistentCache('pancake:team-roster:v1:test', {})
    return race.run(race.tab('A'), 'queue.pendingMutations().length') as number
}

export function agedCompletion() {
    const race = storageRace(), writer = race.tab('A')
    race.run(writer, enqueue)
    const stale = race.tab('A')
    race.run(writer, start)
    race.now += 8 * 24 * 60 * 60 * 1000
    race.run(stale, start)
    return { sends: race.sends.length, pending: race.run(stale, 'queue.pendingMutations().length') as number }
}

export function legacyClear() {
    const race = storageRace([records[0]]), tab = race.tab('A')
    persistentCache(tab).clearPersistentCaches()
    const pending = race.run(tab, 'queue.pendingMutations().length') as number
    race.run(tab, start)
    return { case: 'clear', pending, sends: race.sends.length }
}

export function quotaReload(blockRemoval = false) {
    const race = storageRace(), writer = race.tab('A')
    writer.console = { ...console, error() {} }
    race.run(writer, enqueue)
    race.onBeforeSet = () => { throw new Error('QuotaExceededError') }
    if (blockRemoval) race.onRemove = () => { throw new Error('Removal unavailable') }
    race.run(writer, start)
    const restored = race.tab('A')
    restored.console = writer.console
    race.run(restored, start)
    return { case: 'quota', caller: writer.result as string, sends: race.sends.length }
}

export function cleanupReplayRace(restoreInput = false) {
    const race = storageRace(), writer = race.tab('A'), id = 'A:' + records[0].id
    const marker = completionPrefix + id, entry = 'pancake:offline-mutation:v1:' + id
    race.run(writer, enqueue + ';' + start)
    race.now += 8 * 86400000
    const stale = race.tab('A')
    writer.input = { ...records[1], accountId: 'A', path: '/second' }
    let interleaved = false
    race.onGet = (name, value) => {
        if (name !== entry || value !== null) return
        race.onGet = key => { if (key === marker) throw new Error('Transient completion read failure') }
        if (restoreInput) race.values.set(entry, JSON.stringify(records[0]))
        else race.run(stale, enqueue)
        race.onGet = undefined
        interleaved = true
    }
    race.run(writer, 'navigator.onLine=false;' + enqueue)
    race.run(writer, start)
    const entryWithoutCompletion = race.values.has(entry) && !race.values.has(marker)
    const restored = race.tab('A')
    race.run(restored, 'paths=[];queue.configureMutationReplay(async job=>{paths.push(job.path);return "saved"});' + start)
    return { interleaved, entryWithoutCompletion, replayedPaths: Array.from(restored.paths) as string[] }
}

export function retryStorageGrowth() {
    const race = storageRace(), tab = race.tab('A')
    tab.console = { error() {} }
    race.onBeforeSet = (key, value) => {
        let bytes = 2 * (key.length + value.length)
        for (const [name, saved] of race.values) if (name !== key) bytes += 2 * (name.length + saved.length)
        if (bytes > 8192) throw new Error('QuotaExceededError')
    }
    let completed = 0, blocked: unknown = null
    for (let index = 1; index <= 30; index++) {
        race.now += 8 * 86400000
        tab.input = { ...records[0], id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}` }
        race.run(tab, 'navigator.onLine=false;result="pending";queue.configureMutationReplay(async()=>{throw new Error("Rejected")});' + enqueue + ';' + start)
        if (tab.result !== 'Rejected') { blocked = tab.result; break }
        race.run(tab, 'queue.configureMutationReplay(async()=>"saved")')
        race.run(tab, 'try{queue.retryMutation(input.id)}catch(error){result=error.message}')
        race.run(tab, start)
        if (race.run(tab, 'queue.pendingMutations().length')) { blocked = tab.result; break }
        completed++
    }
    const retainedFacts = [...race.values.keys()].filter(key => key.includes('-failure:') || key.includes('-retry:')).length
    return { completed, pending: race.run(tab, 'queue.pendingMutations().length') as number, retainedFacts, blocked }
}

export function rejectedQuotaReload() {
    const race = storageRace(), tab = race.tab('A')
    tab.console = { error() {} }
    race.run(tab, enqueue)
    const limit = [...race.values].reduce((bytes, [key, value]) => bytes + 2 * (key.length + value.length), 0) + 200
    race.onBeforeSet = (key, value) => {
        let bytes = 2 * (key.length + value.length)
        for (const [name, saved] of race.values) if (name !== key) bytes += 2 * (name.length + saved.length)
        if (bytes > limit) throw new Error('QuotaExceededError')
    }
    race.run(tab, 'queue.configureMutationReplay(async()=>{record();throw Error("Rejected")});' + start)
    const before = race.run(tab, 'queue.pendingMutations()[0].status') as string
    const restored = race.tab('A')
    restored.console = tab.console
    const reloaded = race.run(restored, 'queue.pendingMutations()[0].status') as string
    race.run(restored, start)
    return { caller: tab.result as string, before, reloaded, sends: race.sends.length }
}

export function liveRetryStorageGrowth() {
    const race = storageRace(), tab = race.tab('A')
    tab.console = { error() {} }
    race.run(tab, enqueue)
    race.onBeforeSet = (key, value) => {
        let bytes = 2 * (key.length + value.length)
        for (const [name, saved] of race.values) if (name !== key) bytes += 2 * (name.length + saved.length)
        if (bytes > 8192) throw new Error('QuotaExceededError')
    }
    race.run(tab, 'queue.configureMutationReplay(async()=>{record();throw Error("Rejected")});' + start)
    let retries = 0
    for (; retries < 30; retries++) {
        race.run(tab, 'retryError=null;try{queue.retryMutation(input.id)}catch(error){retryError=error.message}')
        if (tab.retryError) break
    }
    race.run(tab, 'queue.configureMutationReplay(async()=>{record();return "saved"});retryError=null;try{queue.retryMutation(input.id)}catch(error){retryError=error.message}')
    race.run(tab, start)
    return { retries, pending: race.run(tab, 'queue.pendingMutations().length') as number, retryError: tab.retryError as string | null }
}
