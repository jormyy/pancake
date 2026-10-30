import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { labRoot, requireMini } from '../../scripts/perf-lab/common.mjs'
import { sql } from '../../scripts/perf-lab/database.mjs'

await requireMini()
assert.equal(process.env.PERF_LAB_PROJECT, 'pt4bafablerq')
const root = path.join(labRoot, 'requests')
const walksOnly = process.argv.includes('--walks-only')
const output = (filename) => path.join(labRoot, `${walksOnly ? 'walk-only-' : ''}${filename}`)
const files = (await readdir(root))
    .filter((name) =>
        /^(?:(before|after)-[123]-(walk|idle-home|idle-matchup)|trim-(before|after)-[123]-players|legacy-before-1-players)$/.test(
            name,
        ),
    )
    .filter((name) => !walksOnly || !name.includes('-idle-'))
    .sort()
const allReports = await Promise.all(
    files.map(async (name) => ({
        name,
        ...JSON.parse(await readFile(path.join(root, name, 'report.json'), 'utf8')),
    })),
)
const reports = allReports.filter((report) => report.label === 'before' || report.label === 'after')
const blockedDiagnostics = new Set([
    'https://play.google.com/log',
    'https://ogads-pa.clients6.google.com/$rpc/google.internal.onegoogle.asyncdata.v1.AsyncDataService/GetAsyncData',
])
assert.equal(reports.filter((report) => report.mode === 'walk').length, 6)
assert.equal(reports.filter((report) => report.mode.startsWith('idle-')).length, walksOnly ? 0 : 4)
for (const report of allReports) {
    assert.deepEqual(report.errors, [])
    assert.ok(report.blocked.every((url) => blockedDiagnostics.has(url)))
    for (const row of report.rows) {
        assert.ok(!row.error)
        assert.deepEqual(row.failed ?? [], [])
        assert.deepEqual(row.failedRequests ?? [], [])
    }
    if (report.mode === 'walk') assert.equal(report.rows.length, 93)
    if (report.mode.startsWith('idle-')) assert.equal(report.rows[0].minutes?.length, 10)
}
const authRoleId = await sql("SELECT oid::text FROM pg_roles WHERE rolname='supabase_auth_admin'")
const access = (await readFile(path.join(labRoot, 'evidence/access.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
const used = new Set()
for (const report of allReports)
    for (const row of report.rows) {
        row.dbMs = row.statements
            ?.filter(
                (statement) =>
                    statement.toplevel &&
                    (statement.query.includes('pgrst_source') ||
                        (statement.userid === (report.authRoleId ?? authRoleId) &&
                            /^SELECT\s/i.test(statement.query.trim()))),
            )
            .reduce((sum, statement) => sum + statement.total_exec_time, 0)
        for (const request of row.requests ?? []) {
            const candidates = access
                .map((entry, index) => ({ entry, index }))
                .filter(
                    ({ entry, index }) =>
                        !used.has(index) &&
                        new URL(entry.url).pathname === request.path &&
                        entry.method === request.method &&
                        Math.abs(entry.startedAt + entry.durationMs - request.at) < 1000,
                )
                .sort(
                    (a, b) =>
                        Math.abs(a.entry.startedAt + a.entry.durationMs - request.at) -
                        Math.abs(b.entry.startedAt + b.entry.durationMs - request.at),
                )
            assert.ok(
                candidates.length,
                `Missing wire capture for ${report.name}/${row.screen}/${request.path}`,
            )
            used.add(candidates[0].index)
            request.transferBodyBytes = request.wireBytes
            request.wireBytes = candidates[0].entry.bytesOut
        }
        row.wireBytes = row.requests?.reduce((sum, request) => sum + request.wireBytes, 0)
        let minuteStart = row.startedAt
        for (const minute of row.minutes ?? []) {
            const minuteEnd = minuteStart + minute.seconds * 1000
            minute.wireBytes = row.requests
                .filter((request) => request.at >= minuteStart && request.at < minuteEnd)
                .reduce((sum, request) => sum + request.wireBytes, 0)
            minuteStart = minuteEnd
        }
    }
const median = (values) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
}
const metric = (rows, field, minute = false) =>
    median(rows.map((row) => (minute ? row[field] / (row.seconds / 60) : row[field])))
const number = (value) => (value === null ? '—' : value.toFixed(value < 100 ? 2 : 0))
const groups = new Map()
for (const report of reports)
    for (const row of report.rows) {
        const key = `${row.screen}/${row.state}`
        const group = groups.get(key) ?? {
            screen: row.screen,
            state: row.state,
            before: [],
            after: [],
        }
        group[report.label].push({ ...row, report: report.name })
        groups.set(key, group)
    }
const rows = [...groups.values()].map((group) => {
    const idle = group.state === 'idle'
    return {
        screen: group.screen,
        state: group.state,
        before: Object.fromEntries(
            ['requestCount', 'rawBytes', 'wireBytes', 'gzipBytes', 'dbMs'].map((field) => [
                field,
                metric(group.before, field, idle),
            ]),
        ),
        after: Object.fromEntries(
            ['requestCount', 'rawBytes', 'wireBytes', 'gzipBytes', 'dbMs'].map((field) => [
                field,
                metric(group.after, field, idle),
            ]),
        ),
        samples: [group.before.length, group.after.length],
        errors: [...group.before, ...group.after].flatMap((row) =>
            row.error
                ? [row.error]
                : row.failed?.length
                  ? [`${row.report}: ${row.failed.length} HTTP errors`]
                  : [],
        ),
    }
})
const rpcRows = new Map()
for (const report of reports)
    for (const row of report.rows)
        for (const statement of row.statements ?? []) {
            if (!statement.toplevel || !statement.query.includes('pgrst_source')) continue
            const names = [
                ...new Set(
                    [...statement.query.matchAll(/"public"\."([a-z_]+)"/g)].map(
                        (match) => match[1],
                    ),
                ),
            ]
            const key = `${report.label}/${row.screen}/${row.state}/${names.join(',') || 'PostgREST'}`
            const entry = rpcRows.get(key) ?? {
                label: report.label,
                screen: row.screen,
                state: row.state,
                rpc: names.join(',') || 'PostgREST',
                calls: 0,
                dbMs: 0,
            }
            entry.calls += statement.calls
            entry.dbMs += statement.total_exec_time
            rpcRows.set(key, entry)
        }
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const screenshots = []
for (const group of groups.values()) {
    if (!group.before.length || !group.after.length) continue
    const filename = `${group.screen}-${group.state}.png`
    const images = await Promise.all(
        [group.before[0], group.after[0]].map((row) =>
            readFile(path.join(root, row.report, filename)).catch(() => null),
        ),
    )
    screenshots.push({
        screen: group.screen,
        state: group.state,
        available: images.every(Boolean),
        identical: images.every(Boolean) && hash(images[0]) === hash(images[1]),
    })
}
const minutes = reports
    .filter((report) => report.mode.startsWith('idle-'))
    .flatMap((report) =>
        report.rows.flatMap(
            (row) =>
                row.minutes?.map((minute) => ({
                    label: report.label,
                    screen: row.screen,
                    ...minute,
                })) ?? [
                    {
                        label: report.label,
                        screen: row.screen,
                        aggregate: true,
                        seconds: row.seconds,
                        requests: row.requestCount,
                        rawBytes: row.rawBytes,
                        wireBytes: row.wireBytes,
                        dbMs: row.dbMs,
                    },
                ],
        ),
    )
const walkTotals = reports
    .filter((report) => report.mode === 'walk')
    .map((report) => ({
        label: report.label,
        round: report.round,
        ...Object.fromEntries(
            ['requestCount', 'rawBytes', 'wireBytes', 'dbMs'].map((field) => [
                field,
                report.rows.reduce((sum, row) => sum + (row[field] ?? 0), 0),
            ]),
        ),
        versionRequests: report.rows.reduce(
            (sum, row) =>
                sum +
                (row.requests?.filter((request) => request.path === '/functions/v1/api/version')
                    .length ?? 0),
            0,
        ),
    }))
const pairedGains = ['1', '2', '3'].flatMap((round) => {
    const before = walkTotals.find((row) => row.label === 'before' && row.round === round)
    const after = walkTotals.find((row) => row.label === 'after' && row.round === round)
    return before && after
        ? [
              {
                  round,
                  ...Object.fromEntries(
                      ['requestCount', 'rawBytes', 'wireBytes', 'dbMs', 'versionRequests'].map(
                          (field) => [field, before[field] - after[field]],
                      ),
                  ),
              },
          ]
        : []
})
const summary = {
    generatedAt: new Date().toISOString(),
    reports: reports.map(({ name, buildSha, errors, blocked, finishedAt }) => ({
        name,
        buildSha,
        errors,
        blocked,
        finishedAt,
    })),
    rows,
    rpcs: [...rpcRows.values()].map((row) => ({ ...row, msPerCall: row.dbMs / row.calls })),
    screenshots,
    minutes,
    walkTotals,
    pairedGains,
    trimTotals: allReports
        .filter((report) => report.label.startsWith('trim-'))
        .map((report) => ({
            label: report.label,
            round: report.round,
            ...Object.fromEntries(
                ['requestCount', 'rawBytes', 'wireBytes', 'dbMs'].map((field) => [
                    field,
                    report.rows.reduce((sum, row) => sum + (row[field] ?? 0), 0),
                ]),
            ),
        })),
    trimContracts: JSON.parse(await readFile(path.join(labRoot, 'trim-contracts.json'), 'utf8')),
    legacy: allReports
        .filter((report) => report.label.startsWith('legacy-'))
        .map(({ name, buildSha, rows }) => ({ name, buildSha, states: rows.length })),
}
await writeFile(output('request-summary.json'), JSON.stringify(summary, null, 2))
const lines = [
    '| Screen | State | n before/after | Requests before → after | Raw B before → after | Compressed B before → after | DB ms before → after |',
    '|---|---|---:|---:|---:|---:|---:|',
]
for (const row of rows)
    lines.push(
        `| ${row.screen} | ${row.state} | ${row.samples.join('/')} | ${number(row.before.requestCount)} → ${number(row.after.requestCount)} | ${number(row.before.rawBytes)} → ${number(row.after.rawBytes)} | ${number(row.before.wireBytes)} → ${number(row.after.wireBytes)} | ${number(row.before.dbMs)} → ${number(row.after.dbMs)} |`,
    )
await writeFile(output('request-table.md'), `${lines.join('\n')}\n`)
const rpcGroups = new Map()
for (const row of summary.rpcs) {
    const key = `${row.screen}/${row.state}/${row.rpc}`
    const group = rpcGroups.get(key) ?? {
        screen: row.screen,
        state: row.state,
        rpc: row.rpc,
        before: { calls: 0, dbMs: 0 },
        after: { calls: 0, dbMs: 0 },
    }
    group[row.label].calls += row.calls
    group[row.label].dbMs += row.dbMs
    rpcGroups.set(key, group)
}
const rpcLines = [
    '| Screen / state | RPC or relation | Calls per run before → after | DB ms per SQL call before → after |',
    '|---|---|---:|---:|',
]
for (const group of rpcGroups.values()) {
    const samples = groups.get(`${group.screen}/${group.state}`)
    const calls = (label) => number(group[label].calls / samples[label].length)
    const ms = (label) => number(group[label].calls ? group[label].dbMs / group[label].calls : null)
    rpcLines.push(
        `| ${group.screen} / ${group.state} | ${group.rpc} | ${calls('before')} → ${calls('after')} | ${ms('before')} → ${ms('after')} |`,
    )
}
await writeFile(output('request-rpcs.md'), `${rpcLines.join('\n')}\n`)
const minuteLines = [
    '| Screen | Minute | Requests before → after | Raw B before → after | Compressed B before → after | DB ms before → after |',
    '|---|---:|---:|---:|---:|---:|',
]
for (const screen of ['idle-home', 'idle-matchup']) {
    for (let minute = 1; minute <= 10; minute++) {
        const find = (label) =>
            minutes.find(
                (row) => row.screen === screen && row.label === label && row.minute === minute,
            )
        const before = find('before')
        const after = find('after')
        minuteLines.push(
            `| ${screen} | ${minute} | ${['requests', 'rawBytes', 'wireBytes', 'dbMs'].map((field) => `${number(before?.[field] ?? null)} → ${number(after?.[field] ?? null)}`).join(' | ')} |`,
        )
    }
}
await writeFile(output('request-minutes.md'), `${minuteLines.join('\n')}\n`)
console.log(
    JSON.stringify({
        reports: summary.reports.map((row) => row.name),
        measurements: rows.length,
        errors: rows.flatMap((row) => row.errors),
        screenshots: screenshots.length,
        identical: screenshots.filter((row) => row.identical).length,
    }),
)
