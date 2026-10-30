import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { gzipSync } from 'node:zlib'
import { labRoot, requireMini } from '../../scripts/perf-lab/common.mjs'
import { sql } from '../../scripts/perf-lab/database.mjs'

await requireMini()
assert.equal(process.env.PERF_LAB_PROJECT, 'pt4bafablerq')
assert.equal(process.env.PERF_LAB_PORT_PREFIX, '633')
const { fixture } = JSON.parse(await readFile(path.join(labRoot, 'ready.json'), 'utf8'))
const beforeSql = await readFile(path.join(labRoot, 'view_players-before.sql'), 'utf8')
const afterSql = await readFile('supabase/sql/functions/by-name/public/view_players.sql', 'utf8')
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
for (const value of [fixture.leagueId, fixture.members[0].id, fixture.users[0].id])
    assert.match(value, /^[0-9a-f-]{36}$/)
const read = (name, params) =>
    sql(`BEGIN; SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claims"=${quote(JSON.stringify({ sub: fixture.users[0].id, role: 'authenticated' }))};
  SELECT public.${name}(${quote(fixture.leagueId)}::uuid,${quote(fixture.members[0].id)}::uuid,${quote(JSON.stringify(params))}::jsonb);
  ROLLBACK;`).then(JSON.parse)
const cases = [
    { name: 'free-agents', params: { availability: 'free_agents', limit: 20 }, trim: true },
    {
        name: 'next-page',
        params: { availability: 'free_agents', limit: 20, offset: 20 },
        trim: true,
    },
    {
        name: 'search',
        params: {
            availability: 'free_agents',
            limit: 20,
            query: fixture.players[220].display_name,
        },
        trim: true,
    },
    {
        name: 'position',
        params: { availability: 'free_agents', limit: 20, position: 'PG' },
        trim: true,
    },
    {
        name: 'rookies',
        params: { availability: 'free_agents', limit: 20, rookiesOnly: true },
        trim: true,
    },
    { name: 'default', params: { limit: 20 }, trim: false },
    { name: 'all', params: { availability: 'all', limit: 20 }, trim: false },
    { name: 'mine', params: { availability: 'mine', limit: 20 }, trim: false },
    { name: 'rostered', params: { availability: 'rostered', limit: 20 }, trim: false },
    { name: 'waivers', params: { availability: 'waivers', limit: 20 }, trim: false },
    {
        name: 'explicit-support',
        params: {
            availability: 'free_agents',
            includePlayerIds: [fixture.players[0].id],
            limit: 1,
        },
        trim: false,
    },
    {
        name: 'claim-editor',
        rpc: 'view_claim_editor',
        params: { playerId: fixture.players[230].id },
        trim: false,
    },
]
const contracts = []
const runWalk = async (label, round) => {
    const directory = path.join(labRoot, 'requests', `${label}-${round}-players`)
    await rename(directory, `${directory}-prior-${Date.now()}`).catch((error) => {
        if (error.code !== 'ENOENT') throw error
    })
    for (let attempt = 1; attempt <= 3; attempt++) {
        const code = await new Promise((resolve, reject) => {
            const child = spawn(
                process.execPath,
                ['tests/e2e/l5c-requests.mjs', label, round, 'players'],
                { stdio: 'inherit' },
            )
            child.on('error', reject)
            child.on('close', resolve)
        })
        const report = await readFile(path.join(directory, 'report.json'), 'utf8')
            .then(JSON.parse)
            .catch(() => null)
        const failed =
            code !== 0 ||
            !report ||
            report.errors.length ||
            report.rows.some((row) => row.error || row.failed?.length || row.failedRequests?.length)
        if (!failed) return report
        if (attempt === 3) throw new Error(`${label}/${round} failed three attempts`)
        await rename(directory, `${directory}-rejected-${Date.now()}`).catch((error) => {
            if (error.code !== 'ENOENT') throw error
        })
        console.log(`Retrying ${label}/${round}; failed capture retained`)
    }
}
let passed = false
try {
    await sql(beforeSql)
    const originals = []
    for (const test of cases) originals.push(await read(test.rpc ?? 'view_players', test.params))
    await sql(afterSql)
    for (const [index, test] of cases.entries()) {
        const before = originals[index]
        const after = await read(test.rpc ?? 'view_players', test.params)
        if (test.trim) {
            assert.ok(
                Object.keys(before.ownedMap).length > 0,
                `${test.name} needs populated ownership`,
            )
            assert.ok(
                before.players.every((player) => !before.ownedMap[player.id]),
                `${test.name} contains an owned player`,
            )
            assert.deepEqual(
                after,
                { ...before, ownedMap: {} },
                `${test.name} changed rendered data`,
            )
        } else assert.deepEqual(after, before, `${test.name} changed a legacy response`)
        const encoded = (value) => Buffer.from(JSON.stringify(value))
        contracts.push({
            name: test.name,
            passed: true,
            rawBefore: encoded(before).length,
            rawAfter: encoded(after).length,
            gzipBefore: gzipSync(encoded(before)).length,
            gzipAfter: gzipSync(encoded(after)).length,
        })
    }
    await writeFile(path.join(labRoot, 'trim-contracts.json'), JSON.stringify(contracts, null, 2))
    console.log(`${contracts.length} response contracts passed`)
    for (let index = 0; index < 6; index++) {
        const label = index % 2 ? 'trim-after' : 'trim-before'
        const round = String(Math.floor(index / 2) + 1)
        await sql(index % 2 ? afterSql : beforeSql)
        await delay(8000)
        await runWalk(label, round)
    }
    await rm(path.join(labRoot, 'web-export'), { recursive: true })
    await cp(path.join(labRoot, 'before-export'), path.join(labRoot, 'web-export'), {
        recursive: true,
    })
    await runWalk('legacy-before', '1')
    console.log('Release 2.9.1 Players walk passed against the trimmed server response')
    passed = true
} finally {
    if (!passed) await sql(beforeSql)
    await rm(path.join(labRoot, 'web-export'), { recursive: true })
    await cp(path.join(labRoot, 'after-export'), path.join(labRoot, 'web-export'), {
        recursive: true,
    })
}
