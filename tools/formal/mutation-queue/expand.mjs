import { parentPort, workerData } from 'node:worker_threads'
import { apply, createWorld, enabled, fingerprint } from './model.mjs'

const { repo, initial, paths } = workerData
const replay = async steps => {
    const world = await createWorld(repo, initial)
    for (const step of steps) await apply(world, step)
    return world
}
const children = []
for (const steps of paths) {
    for (const op of enabled(await replay(steps))) {
        const world = await replay(steps)
        const violation = await apply(world, op)
        children.push({ steps: [...steps, op], key: violation ? null : fingerprint(world), violation })
        if (violation) break
    }
}
parentPort.postMessage(children)
