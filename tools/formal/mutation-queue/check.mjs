#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableParallelism } from 'node:os'
import vm from 'node:vm'
import { Worker } from 'node:worker_threads'

const here = path.dirname(fileURLToPath(import.meta.url))
if (!vm.SourceTextModule) {
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' })
    process.exit(result.status ?? 1)
}

const { apply, createWorld, enabled } = await import('./model.mjs')
const repo = path.resolve(here, '../../..')
const plan = JSON.parse(readFileSync(path.join(here, 'replays.json'), 'utf8'))
const unlimited = Object.fromEntries(Object.keys(plan.search.budget).map(name => [name, name === 'actions' ? 3 : Infinity]))
const report = violation => `  ${violation.message}.\n  Fix: ${violation.fix}`
let failed = false

for (const replay of plan.replays) {
    const world = await createWorld(repo, { ...plan.initial, budget: unlimited })
    let violation = world.violation
    for (const step of replay.steps) {
        if (violation) break
        if (!enabled(world).includes(step)) { violation = { message: `step "${step}" cannot run here; the queue did not reach the state this replay expects`, fix: `Compare the queue against the ${replay.fixedBy} behavior this replay pins.` }; break }
        violation = await apply(world, step)
    }
    failed ||= Boolean(violation)
    console.log(`${violation ? 'FAIL' : 'ok'} replay ${replay.name}`)
    if (violation) console.log(`  after: ${world.trace.join(', then ')}\n${report(violation)}`)
}

const depthFlag = process.argv.indexOf('--depth')
const depth = depthFlag > 0 ? Number(process.argv[depthFlag + 1]) : plan.search.depth
const { budget } = plan.search
const initial = { ...plan.initial, budget }
const workers = Math.max(1, availableParallelism() - 1)
const expand = paths => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./expand.mjs', import.meta.url), { workerData: { repo, initial, paths } })
    worker.once('message', resolve)
    worker.once('error', reject)
})
const seen = new Set()
let frontier = [[]]
let states = 0
let counterexample = null
for (let level = 0; level < depth && frontier.length && !counterexample; level++) {
    const size = Math.max(1, Math.min(150, Math.ceil(frontier.length / workers)))
    const chunks = []
    for (let start = 0; start < frontier.length; start += size) chunks.push(frontier.slice(start, start + size))
    const results = []
    let taken = 0
    await Promise.all(Array.from({ length: Math.min(workers, chunks.length) }, async () => {
        while (taken < chunks.length) {
            const index = taken++
            results[index] = await expand(chunks[index])
        }
    }))
    const next = []
    for (const child of results.flat()) {
        if (child.violation) { counterexample = child; break }
        if (seen.has(child.key)) continue
        seen.add(child.key)
        states++
        next.push(child.steps)
    }
    frontier = next
}
if (counterexample) {
    failed = true
    console.log(`FAIL search: violation after ${counterexample.steps.length} steps: ${counterexample.steps.join(', then ')}\n${report(counterexample.violation)}`)
} else console.log(`ok search: no violation in ${states} distinct states, up to ${depth} steps, 2 tabs, 2 accounts`)
process.exit(failed ? 1 : 0)
