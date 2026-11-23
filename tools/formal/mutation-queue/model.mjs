import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'

const now = 2_000_000_000_000
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const actionIds = ['X', 'Y', 'Z'].map((name, index) => [name, `00000000-0000-4000-8000-00000000000${index + 1}`])
const actionName = Object.fromEntries(actionIds.map(([name, id]) => [id, name]))
const other = { A: 'B', B: 'A' }

const fixes = {
    account: 'Replay must check the sending tab still belongs to the action\'s account, and stop the replay loop of an older session generation.',
    completedSent: 'Before each send, re-read the completion record other tabs write; treat an unreadable record as "cannot send yet", never as "not completed".',
    rejectedSent: 'Save each rejection as a record every tab reads before sending, and send a rejected action again only after an explicit retry.',
    unsavedSent: 'When queueMutation tells the caller the action could not be saved, drop it from memory so replay never sends it.',
    completedFailed: 'When storage shows another tab completed or removed an action, drop this tab\'s unsaved copy of it instead of merging it back.',
    falseFailure: 'A send that fails while offline is a network drop: keep the action pending (the offline early return in replay) and resend once online.',
    lost: 'Persist each queued action as its own record and import older lists before overwriting them, so no tab\'s write erases another tab\'s action.',
    stalled: 'Resume replay after every outcome and event, and never let a completed, failed-elsewhere or other-account action sit at the head of this account\'s queue.',
}

const sourceCache = new Map()
function source(file) {
    if (!sourceCache.has(file)) sourceCache.set(file, stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' }))
    return sourceCache.get(file)
}

function sharedStorage(world) {
    const values = new Map()
    const deny = () => { throw new Error('Storage write failed') }
    const api = {
        get length() { return values.size },
        key: index => [...values.keys()][index] ?? null,
        getItem: name => {
            if (world.proof === 'hidden' && String(name).includes(':offline-mutation-done:')) throw new Error('Storage read failed')
            return values.get(String(name)) ?? null
        },
        setItem: (name, value) => { if (world.storage === 'down') deny(); values.set(String(name), String(value)) },
        removeItem: name => { if (world.storage === 'down') deny(); values.delete(String(name)) },
        clear: () => { if (world.storage === 'down') deny(); values.clear() },
    }
    const storage = new Proxy(api, {
        ownKeys: () => [...values.keys()],
        getOwnPropertyDescriptor: (target, name) => typeof name === 'string' && values.has(name)
            ? { configurable: true, enumerable: true, writable: true, value: values.get(name) }
            : Reflect.getOwnPropertyDescriptor(target, name),
        has: (target, name) => name in target || values.has(name),
    })
    return { values, storage }
}

async function openTab(world, index, owner) {
    const window = new EventTarget()
    window.localStorage = world.disk.storage
    const quiet = { ...console, error() {}, warn() {}, log() {} }
    const context = vm.createContext({
        console: quiet, window, navigator: { get onLine() { return world.online } },
        crypto: { randomUUID: () => `ffffffff-0000-4000-8000-${String(++world.serial).padStart(12, '0')}` },
        setTimeout, clearTimeout, queueMicrotask,
    })
    vm.runInContext(`Date.now = () => ${now}`, context)
    const modules = new Map()
    const load = specifier => {
        if (!specifier.startsWith('@/')) throw new Error(`The model cannot load ${specifier}; stub it in tools/formal/mutation-queue/model.mjs.`)
        const file = path.join(world.repo, `${specifier.slice(2)}.ts`)
        if (!modules.has(file)) modules.set(file, new vm.SourceTextModule(source(file), { context, identifier: file }))
        return modules.get(file)
    }
    const queueModule = load('@/lib/cache/mutation-queue')
    const sessionModule = load('@/lib/session-cache-registry')
    await queueModule.link(load)
    if (sessionModule.status === 'unlinked') await sessionModule.link(load)
    await sessionModule.evaluate()
    sessionModule.namespace.setSessionOwner(owner)
    await queueModule.evaluate()
    const tab = { index, window, session: sessionModule.namespace, queue: queueModule.namespace, live: true }
    world.tabs[index] = tab
    tab.queue.configureMutationReplay(job => send(world, tab, job))
    return tab
}

function send(world, tab, job) {
    const action = world.actions.get(actionName[job.id] ?? job.id)
    const name = actionName[job.id] ?? job.id
    const label = `T${tab.index + 1}`
    if (!tab.live) return new Promise(() => {})
    if (job.accountId !== tab.session.sessionOwner()) world.violate('account', `${label} sent ${name} for account ${job.accountId} while signed in as ${tab.session.sessionOwner()}`)
    else if (!action || action.state === 'unsaved') world.violate('unsavedSent', `${label} sent ${name} after its caller was told it could not be saved`)
    else if (action.completed) world.violate('completedSent', `${label} sent ${name} again after it completed`)
    else if (action.state === 'rejected' && action.durable) world.violate('rejectedSent', `${label} sent ${name} again after a saved rejection, with no retry`)
    world.sent.push(name)
    return new Promise((resolve, reject) => world.held.push({ name, tab: tab.index, resolve, reject }))
}

const flush = () => new Promise(resolve => setImmediate(resolve))

export async function createWorld(repo, initial) {
    const world = {
        repo, online: initial.online, storage: 'up', proof: 'shown', serial: 0, tabs: [], actions: new Map(), held: [], sent: [],
        budget: { ...initial.budget }, violation: null, trace: [],
        violate(kind, message) { if (!this.violation) this.violation = { kind, message, fix: fixes[kind] } },
    }
    world.disk = sharedStorage(world)
    for (const [index, owner] of initial.tabs.entries()) await openTab(world, index, owner)
    await flush()
    for (const tab of world.tabs) tab.view = diskKey(world)
    return world
}

export function enabled(world) {
    const ops = []
    const live = world.tabs.filter(tab => tab.live)
    for (const tab of live) {
        const label = `T${tab.index + 1}`
        if (world.actions.size < world.budget.actions) ops.push(`enqueue ${label}`)
        if (world.online) ops.push(`wake ${label}`)
        if (world.budget.switches > 0) ops.push(`switch ${label}`)
        if (world.budget.reloads > 0) ops.push(`reload ${label}`)
        if (world.budget.retries > 0 && [...world.actions.values()].some(action => action.account === tab.session.sessionOwner() && action.state === 'rejected')) ops.push(`retry ${label}`)
    }
    for (const held of world.held) ops.push(`succeed ${held.name}@T${held.tab + 1}`, `fail ${held.name}@T${held.tab + 1}`)
    if (world.budget.network > 0) ops.push(world.online ? 'offline' : 'online')
    if (world.budget.storage > 0) ops.push(world.storage === 'up' ? 'storage-down' : 'storage-up')
    if (world.budget.proof > 0) ops.push(world.proof === 'shown' ? 'proof-unreadable' : 'proof-readable')
    return ops
}

export async function apply(world, op) {
    world.trace.push(op)
    const [verb, target] = op.split(' ')
    const tab = target?.startsWith('T') ? world.tabs[Number(target.slice(1)) - 1] : undefined
    const faulted = world.storage === 'down' || world.proof === 'hidden'
    let woke = null
    if (verb === 'enqueue') {
        const [name, id] = actionIds[world.actions.size]
        const action = { name, account: tab.session.sessionOwner(), state: 'pending', durable: false, completed: false, caller: 'waiting' }
        world.actions.set(name, action)
        tab.queue.queueMutation({ accountId: action.account, leagueId: null, rowIds: [id], path: `/model/${name}`, body: '{}' }, id)
            .then(() => { action.caller = 'resolved' }, error => { action.caller = error.message })
        await flush()
        if (action.caller !== 'waiting' && action.caller !== 'resolved' && !tab.queue.mutationSnapshot().some(job => job.id === id)) action.state = 'unsaved'
        woke = tab
    } else if (verb === 'wake') {
        tab.window.dispatchEvent(new Event('online'))
        woke = tab
    } else if (verb === 'switch') {
        world.budget.switches--
        tab.session.setSessionOwner(other[tab.session.sessionOwner()])
        void tab.queue.replayMutations()
        woke = tab
    } else if (verb === 'reload') {
        world.budget.reloads--
        tab.live = false
        world.held = world.held.filter(held => held.tab !== tab.index)
        woke = await openTab(world, tab.index, tab.session.sessionOwner())
    } else if (verb === 'retry') {
        world.budget.retries--
        const job = tab.queue.pendingMutations().find(item => item.status === 'failed')
        const action = job && world.actions.get(actionName[job.id])
        if (action) {
            const before = { state: action.state, durable: action.durable }
            Object.assign(action, { state: 'pending', durable: false })
            try { tab.queue.retryMutation(job.id) } catch { Object.assign(action, before) }
        }
        woke = tab
    } else if (verb === 'succeed' || verb === 'fail') {
        const [name, at] = target.split('@')
        const index = world.held.findIndex(held => held.name === name && `T${held.tab + 1}` === at)
        const [held] = world.held.splice(index, 1)
        const action = world.actions.get(name)
        woke = world.tabs[held.tab]
        if (verb === 'succeed') {
            if (world.storage === 'up') action.completed = true
            action.state = 'done'
            held.resolve('saved')
        } else {
            if (world.online) Object.assign(action, { state: 'rejected', durable: world.storage === 'up' })
            held.reject(new Error(`Server rejected ${name}`))
        }
    } else if (verb === 'online' || verb === 'offline') {
        world.budget.network--
        world.online = verb === 'online'
    } else if (verb === 'storage-down' || verb === 'storage-up') {
        world.budget.storage--
        world.storage = verb === 'storage-down' ? 'down' : 'up'
    } else if (verb === 'proof-unreadable' || verb === 'proof-readable') {
        world.budget.proof--
        world.proof = verb === 'proof-unreadable' ? 'hidden' : 'shown'
    } else throw new Error(`Unknown model step: ${op}`)
    await flush()
    observe(world, woke, verb === 'reload', faulted || world.storage === 'down' || world.proof === 'hidden')
    return world.violation
}

const diskKey = world => JSON.stringify([...world.disk.values].map(([name, value]) => `${name}=${value}`.replace(uuid, id => actionName[id] ?? 'F')).sort())

function observe(world, tab, opened, faulted) {
    if (!tab?.live) return
    const label = `T${tab.index + 1}`
    const listed = new Set()
    for (const job of tab.queue.mutationSnapshot()) {
        const name = actionName[job.id] ?? job.id
        const action = world.actions.get(name)
        listed.add(name)
        if (!action || job.status !== 'failed') continue
        if (faulted) { if (action.state === 'pending') Object.assign(action, { state: 'rejected', durable: false }) }
        else if (action.completed) world.violate('completedFailed', `${label} shows ${name} as failed after another tab completed it`)
        else if (action.state === 'pending') world.violate('falseFailure', `${label} shows ${name} as failed though the server never rejected it and storage was healthy`)
    }
    if (opened) for (const action of world.actions.values()) {
        if (['pending', 'rejected'].includes(action.state) && !action.completed && !listed.has(action.name)) world.violate('lost', `${action.name} is queued and unfinished, but newly opened ${label} does not list it`)
    }
    tab.view = diskKey(world)
    if (!world.online || world.storage === 'down' || world.proof === 'hidden') return
    const head = tab.queue.pendingMutations()[0]
    const action = head && world.actions.get(actionName[head.id])
    if (!action) return
    if (action.completed) world.violate('stalled', `${label} keeps completed ${action.name} at the head of its queue`)
    else if (action.state === 'pending' && head.status === 'pending' && !world.held.some(held => held.name === action.name || held.tab === tab.index)) world.violate('stalled', `${label} is online and idle with ${action.name} pending at the head of its queue, but nothing is sending it`)
}

export function fingerprint(world) {
    const actions = [...world.actions.values()].map(action => [action.name, action.account, action.state, action.durable, action.completed])
    const tabs = world.tabs.map(tab => [tab.session.sessionOwner(), tab.view])
    return JSON.stringify([world.online, world.storage, world.proof, world.budget, actions, world.held.map(held => `${held.name}@${held.tab}`).sort(), tabs, diskKey(world)])
}
