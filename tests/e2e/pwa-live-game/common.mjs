import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, rename, writeFile } from 'node:fs/promises'

export const project = 'pt4bafablec1'
export const labRoot = path.resolve(process.env.PWA_LAB_ROOT ?? '/tmp/fable-c1')
assert.ok(labRoot === '/tmp/fable-c1' || labRoot.startsWith(`${process.cwd()}/tests/artifacts/`))
assert.equal(process.versions.node.split('.')[0], '22')
process.env.PERF_LAB_PROJECT = project
process.env.PERF_LAB_PORT_PREFIX = '649'
process.env.PERF_LAB_LANE = 'fable-c1'
process.env.DOCKER_CONTEXT = 'desktop-linux'
delete process.env.DOCKER_HOST

export async function json(file, value) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(`${file}.tmp`, file)
}
