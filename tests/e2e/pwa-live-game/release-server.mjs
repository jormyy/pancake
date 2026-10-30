import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export async function releaseServer(root, port, expectedSha) {
    const marker = JSON.parse(await readFile(path.join(root, 'release-provenance.json'), 'utf8'))
    if (expectedSha) assert.equal(marker.commitSha, expectedSha)
    const child = spawn('node', ['tests/e2e/static-web-server.mjs', `--root=${root}`, `--port=${port}`, '--host=127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let timer
    try {
        await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Release server startup timed out')), 10000)
            child.once('error', reject)
            child.once('exit', code => reject(new Error(`Release server exited before readiness: ${code}`)))
            child.stdout.on('data', bytes => { if (bytes.toString().includes('Static E2E web server listening')) resolve(undefined) })
        })
        const served = await fetch(`http://127.0.0.1:${port}/release-provenance.json`).then(response => response.json())
        assert.equal(served.commitSha, marker.commitSha)
        assert.equal(served.bundleDigest, marker.bundleDigest)
        return { child, marker }
    } catch (error) { child.kill('SIGTERM'); throw error }
    finally { clearTimeout(timer) }
}
