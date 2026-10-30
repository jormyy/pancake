import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { withDatabase } from '../../scripts/perf-lab/setup.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'
import { localKeys, sql } from '../../scripts/perf-lab/database.mjs'
import { json, labRoot, project, ports } from '../../scripts/perf-lab/common.mjs'

assert.equal(project, 'pt4bafableas')
assert.equal(ports.db, 64022)
await withDatabase(async () => {
    const keys = await localKeys()
    const url = new URL(keys.DB_URL)
    const recipe = async file => {
        const support = await readFile('tests/db/rules-support.sql', 'utf8')
        const source = (await readFile(file, 'utf8')).replace('\\ir rules-support.sql', () => support)
        return { stdout: await sql(source) }
    }
    const before = await command('git', ['show', 'b3989f9d:supabase/sql/functions/by-name/public/auto_set_lineup_atomic_unchecked.sql'])
    await sql(before.stdout)
    let reproduced = false
    try { await recipe('tests/db/autoset-keep-starters.sql') }
    catch (error) {
        reproduced = error.message.includes('flexible starters can move')
        if (!reproduced) throw error
    }
    assert.ok(reproduced, 'The previous SQL completion must leave a fillable slot empty')
    await sql(await readFile('supabase/migrations/20261214003300_autoset_keep_starters.sql', 'utf8'))
    const result = await recipe('tests/db/autoset-keep-starters.sql')
    assert.equal(result.stdout.trim(), '11')
    for (const file of ['lineup-optimizer-idempotence', 'daily-optimizer-default', 'historical-lineup-lock']) await recipe(`tests/db/${file}.sql`)
    await command('node', ['scripts/regenerate-release-history-attestations.mjs'], {
        env: { ...process.env, SUPABASE_DB_URL: url.href, PANCAKE_TEST_DB_PORT: '64022' },
    })
    await json(path.join(labRoot, 'autoset-sql-final.json'), { project, port: ports.db, flexibleSlotReproduced: reproduced,
        passedChecks: 11, failedChecks: 0, existingRecipesPassed: 3, attestationsRegenerated: true })
    console.log('PASS: 11 auto-set SQL checks and 3 existing lineup recipes; flexible-slot regression reproduced before the repair.')
}, { restore: false })
