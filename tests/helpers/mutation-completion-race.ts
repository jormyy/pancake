import { readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import * as vm from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import type { QueuedMutation } from '@/lib/cache/mutation-queue'

const tabSource = `
const legacy = 'pancake:offline-mutation-completions:v1', prefix = 'pancake:offline-mutation-done:v1:', entry = 'pancake:offline-mutation:v1:';
const storageKeys = () => ['pancake:offline-mutations:v1', ...keys.filter((_, index) => Atomics.load(state, 1) & (1 << index)).map(key => prefix + key), ...keys.filter((_, index) => Atomics.load(state, 3) & (1 << index)).map(key => entry + key)];
const keys = records.map(job => job.accountId + ':' + job.id);
let published = false;
const barrier = () => {
    Atomics.add(state, 2, 1); Atomics.notify(state, 2);
    while (Atomics.load(state, 2) < 2) Atomics.wait(state, 2, 1);
};
const storage = {
    get length() { return storageKeys().length; },
    key(index) { return storageKeys()[index] ?? null; },
    getItem(key) {
        if (key.startsWith(entry)) {
            const index = keys.indexOf(key.slice(entry.length));
            return index >= 0 && (Atomics.load(state, 3) & (1 << index)) ? JSON.stringify(records[index]) : null;
        }
        if (key.startsWith(prefix)) {
            const index = keys.indexOf(key.slice(prefix.length));
            return index >= 0 && (Atomics.load(state, 1) & (1 << index)) ? String(Date.now()) : null;
        }
        const completion = key === legacy;
        if (!completion && key !== 'pancake:offline-mutations:v1') return null;
        const mask = Atomics.load(state, completion ? 1 : 0);
        const value = JSON.stringify((completion ? keys : records).filter((_, index) => mask & (1 << index)));
        if (completion && published && race) { published = false; barrier(); }
        return value;
    },
    setItem(key, value) {
        if (key.startsWith(entry)) {
            Atomics.or(state, 3, 1 << keys.indexOf(key.slice(entry.length)));
            return;
        }
        if (key.startsWith(prefix)) {
            if (race) barrier();
            Atomics.or(state, 1, 1 << keys.indexOf(key.slice(prefix.length)));
            return;
        }
        const completion = key === legacy;
        const mask = JSON.parse(value).reduce((bits, item) => bits | (1 << (completion ? keys.indexOf(item) : records.findIndex(job => job.id === item.id))), 0);
        Atomics.store(state, completion ? 1 : 0, mask);
        if (!completion) published = true;
    },
    removeItem(key) {
        if (key.startsWith(entry)) { Atomics.and(state, 3, ~(1 << keys.indexOf(key.slice(entry.length)))); return; }
        if (key.startsWith(prefix)) { Atomics.and(state, 1, ~(1 << keys.indexOf(key.slice(prefix.length)))); return; }
        Atomics.store(state, key === legacy ? 1 : 0, 0);
    }
};
const view = new Proxy(storage, { ownKeys: storageKeys, getOwnPropertyDescriptor: (target, name) => storageKeys().includes(name) ? { configurable: true, enumerable: true, value: undefined } : Reflect.getOwnPropertyDescriptor(target, name) });
const context = vm.createContext({ console, navigator: { onLine: false }, window: { localStorage: view, addEventListener() {} } });
const cache = {};
function load(name) {
    if (cache[name]) return cache[name].exports;
    const module = { exports: {} }; cache[name] = module;
    vm.runInContext('(function(require,module,exports){' + sources[name] + '\\n})', context)(load, module, module.exports);
    return module.exports;
}
load('@/lib/session-cache-registry').setSessionOwner(owner);
return { queue: load('@/lib/cache/mutation-queue'), context };
`

export async function runCompletionRace(records: QueuedMutation[]) {
    const sources = Object.fromEntries(['api-client', 'session-cache-registry', 'cache/mutation-queue'].map(name => [
        `@/lib/${name}`, transpileModule(readFileSync(`lib/${name}.ts`, 'utf8'), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
        }).outputText,
    ]))
    const state = new Int32Array(new SharedArrayBuffer(16))
    state[0] = 3
    const tab = new Function('sources', 'records', 'state', 'owner', 'race', 'vm', tabSource)
    const stale = records.map(job => tab(sources, records, state, job.accountId, false, vm))
    stale.forEach(instance => instance.queue.mutationSnapshot())
    const workers: Worker[] = []
    try {
        await Promise.all(records.map(job => new Promise<void>((resolve, reject) => {
            const worker = new Worker(`
                const { workerData, parentPort } = require('node:worker_threads'), vm = require('node:vm');
                const { sources, records, buffer, owner, tabSource } = workerData;
                const tab = new Function('sources', 'records', 'state', 'owner', 'race', 'vm', tabSource);
                const instance = tab(sources, records, new Int32Array(buffer), owner, true, vm);
                instance.context.navigator.onLine = true;
                instance.queue.configureMutationReplay(async () => 'saved');
                instance.queue.replayMutations().then(() => parentPort.postMessage('saved'));
            `, { eval: true, workerData: { sources, records, buffer: state.buffer, owner: job.accountId, tabSource } })
            workers.push(worker)
            const timeout = setTimeout(() => { reject(new Error('Completion race timed out')); void worker.terminate() }, 5000)
            worker.once('message', () => { clearTimeout(timeout); resolve() })
            worker.once('error', error => { clearTimeout(timeout); reject(error) })
            worker.once('exit', code => { if (code) { clearTimeout(timeout); reject(new Error(`Completion worker exited ${code}`)) } })
        })))
        const retained = records.filter((_, index) => state[1] & (1 << index))
        let duplicates = 0
        for (const instance of stale) {
            instance.context.navigator.onLine = true
            instance.queue.configureMutationReplay(async () => { duplicates++; return 'duplicate' })
            await instance.queue.replayMutations()
        }
        return { retained: retained.map(job => `${job.accountId}:${job.id}`), duplicates }
    } finally { await Promise.all(workers.map(worker => worker.terminate())) }
}
