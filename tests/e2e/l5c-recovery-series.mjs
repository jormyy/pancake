import assert from 'node:assert/strict'
import { cp, readFile, rename, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { labRoot, requireMini } from '../../scripts/perf-lab/common.mjs'

await requireMini()
assert.equal(process.env.PERF_LAB_PROJECT, 'pt4bafablerq')
const jobs = []
for (let round = 1; round <= 3; round++)
    for (const engine of ['chromium', 'webkit'])
        for (const label of ['before', 'after'])
            jobs.push({ label, engine, round: String(round), group: 'core' })
for (const group of ['faults', 'idle'])
    for (const engine of ['chromium', 'webkit'])
        for (const label of ['before', 'after']) jobs.push({ label, engine, round: '1', group })
const start = Number(process.argv[2] ?? 0)
for (const [index, job] of jobs.entries()) {
    if (index < start) continue
    const { label, engine, round, group } = job
    const directory = path.join(labRoot, 'recovery', `${label}-${engine}-${round}-${group}`)
    await rm(path.join(labRoot, 'web-export'), { recursive: true })
    await cp(path.join(labRoot, `recovery-${label}-export`), path.join(labRoot, 'web-export'), {
        recursive: true,
    })
    for (let attempt = 1; attempt <= 3; attempt++) {
        await rename(directory, `${directory}-prior-${Date.now()}`).catch((error) => {
            if (error.code !== 'ENOENT') throw error
        })
        const code = await new Promise((resolve, reject) => {
            const child = spawn(
                process.execPath,
                ['tests/e2e/l5c-recovery.mjs', label, engine, round, group],
                { stdio: 'inherit' },
            )
            child.on('close', resolve)
            child.on('error', reject)
        })
        const report = await readFile(path.join(directory, 'report.json'), 'utf8')
            .then(JSON.parse)
            .catch(() => null)
        if (code === 0 && report && report.rows.every((row) => !row.error)) break
        if (attempt === 3) throw new Error(`Capture failed: ${JSON.stringify(job)}`)
        console.log(`Retrying capture ${index}: ${label}/${engine}/${round}/${group}`)
    }
    console.log(`Completed capture ${index}: ${label}/${engine}/${round}/${group}`)
}
