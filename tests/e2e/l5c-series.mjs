import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { labRoot, requireMini } from '../../scripts/perf-lab/common.mjs'
import { sql } from '../../scripts/perf-lab/database.mjs'

await requireMini()
assert.equal(process.env.PERF_LAB_PROJECT, 'pt4bafablerq')
assert.equal(process.env.PERF_LAB_PORT_PREFIX, '633')
const first = Number(process.argv[2] ?? 0)
for (let index = first; index < 6; index++) {
    const label = index % 2 ? 'after' : 'before'
    const round = String(Math.floor(index / 2) + 1)
    if (process.env.L5C_COMPARE_SQL === '1') {
        const filename =
            index % 2
                ? 'supabase/sql/functions/by-name/public/view_players.sql'
                : path.join(labRoot, 'view_players-before.sql')
        await sql(await readFile(filename, 'utf8'))
        await delay(8000)
    }
    await rm(path.join(labRoot, 'web-export'), { recursive: true })
    await cp(path.join(labRoot, `${label}-export`), path.join(labRoot, 'web-export'), {
        recursive: true,
    })
    const directory = path.join(labRoot, 'requests', `${label}-${round}-walk`)
    await rename(directory, `${directory}-prior-${Date.now()}`).catch((error) => {
        if (error.code !== 'ENOENT') throw error
    })
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const code = await new Promise((resolve, reject) => {
                const child = spawn(
                    process.execPath,
                    ['tests/e2e/l5c-requests.mjs', label, round, 'walk'],
                    { stdio: 'inherit' },
                )
                child.on('error', reject)
                child.on('close', resolve)
            })
            assert.equal(code, 0, `${label}/${round} process failed`)
            const report = JSON.parse(
                await readFile(
                    path.join(labRoot, 'requests', `${label}-${round}-walk/report.json`),
                    'utf8',
                ),
            )
            assert.deepEqual(report.errors, [], `${label}/${round} browser errors`)
            assert.deepEqual(
                report.rows
                    .filter((row) => row.error)
                    .map(({ screen, error }) => ({ screen, error })),
                [],
                `${label}/${round} action errors`,
            )
            assert.deepEqual(
                report.rows.flatMap((row) => row.failedRequests ?? []),
                [],
                `${label}/${round} failed requests`,
            )
            assert.deepEqual(
                report.rows.flatMap((row) => row.failed ?? []),
                [],
                `${label}/${round} HTTP errors`,
            )
            console.log(`Completed ${label}/${round}`)
            assert.equal(report.rows.length, 93)
            break
        } catch (error) {
            if (attempt === 3) throw error
            await rename(directory, `${directory}-rejected-${Date.now()}`)
            console.log(`Retrying ${label}/${round}: ${error.message}`)
        }
    }
}
