import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { localKeys, sql } from './database.mjs'

export async function startPrivateEdge(evidence) {
    const keys = await localKeys()
    const token = randomBytes(32).toString('hex')
    await sql(`ALTER DATABASE postgres SET app.supabase_url='http://host.docker.internal:64981'; ALTER DATABASE postgres SET app.edge_internal_token='${token}';`)
    const child = spawn('deno', ['run', '--cached-only', '--node-modules-dir=manual', '--allow-sys', '--allow-read', '--allow-write', '--allow-env', '--allow-net=127.0.0.1:64921,localhost:64921,127.0.0.1:64981,127.0.0.1:64980', 'tests/e2e/pwa-live-game/edge.mjs'], {
        env: { ...process.env, DENO_NO_UPDATE_CHECK: '1', SUPABASE_URL: keys.API_URL, SUPABASE_ANON_KEY: keys.ANON_KEY,
            SUPABASE_SERVICE_ROLE_KEY: keys.SERVICE_ROLE_KEY, PANCAKE_SUPABASE_SECRET_KEY: keys.SECRET_KEY ?? keys.SERVICE_ROLE_KEY,
            PANCAKE_EDGE_INTERNAL_TOKEN: token, PERF_LAB_EVIDENCE: evidence, PERF_LAB_EDGE_PORT: '64981' },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    const log = createWriteStream(path.join(evidence, 'edge.log'))
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    const close = async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const done = new Promise(resolve => child.once('close', resolve))
            child.kill('SIGTERM')
            const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
            await done
            clearTimeout(timer)
        }
        await new Promise(resolve => log.end(resolve))
    }
    try {
        for (let attempt = 0; attempt < 120; attempt++) {
            assert.ok(child.exitCode === null, 'Private Edge failed; inspect this lane edge.log')
            if (await fetch('http://127.0.0.1:64981/health').then(response => response.ok).catch(() => false)) return { keys, close }
            await delay(500)
        }
        throw new Error('Private Edge startup timed out')
    } catch (error) { await close(); throw error }
}
