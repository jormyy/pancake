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
