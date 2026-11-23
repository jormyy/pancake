#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, rulesAt } from './extract.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../..')
const coverage = JSON.parse(readFileSync(path.join(here, 'coverage.json'), 'utf8'))
const tlc = coverage.tlc
const jar =
    process.env.TLA2TOOLS ??
    path.join(homedir(), '.cache/pancake-formal', `tla2tools-${tlc.version}`, 'tla2tools.jar')
const fail = (message) => {
    console.error(message)
    process.exit(1)
}

if (process.argv.includes('--install') && !existsSync(jar)) {
    mkdirSync(path.dirname(jar), { recursive: true })
    const response = await fetch(tlc.url)
    if (!response.ok) fail(`TLC download failed: ${response.status}`)
    writeFileSync(jar, Buffer.from(await response.arrayBuffer()))
}
if (!existsSync(jar))
    fail(`TLC ${tlc.version} is missing at ${jar}. Rerun with --install, or set TLA2TOOLS.`)
const digest = createHash('sha256').update(readFileSync(jar)).digest('hex')
if (digest !== tlc.sha256)
    fail(`${jar} has sha256 ${digest}; expected TLC ${tlc.version} ${tlc.sha256}.`)

const java = [
    process.env.JAVA,
    'java',
    '/opt/homebrew/opt/openjdk@21/bin/java',
    '/opt/homebrew/opt/openjdk/bin/java',
]
    .filter(Boolean)
    .find((candidate) => spawnSync(candidate, ['-version']).status === 0)
if (!java) fail('Java 11 or later is required. Set JAVA to a java binary.')

const fixes = {
    LivePollFirst:
        "live-poll stayed due while a worker slot was free. Claim live-poll first in private.work_claim (ORDER BY CASE WHEN item.kind='live-poll' THEN 0 ELSE 1 END, ...) and keep the public.dispatch_work loop limit (EXIT WHEN v_count>=N) above an inline SQL burst.",
    BackgroundKindsRun:
        'a due kind went unclaimed for more than FairBound dispatches. Rotate background kinds by private.work_kinds.last_claimed_at in private.work_claim, put empty matchup-forecasts in the background class, and let only work with real input go ahead of it.',
    StalledLivePollRetries:
        'a lost live-poll invocation was not claimed again within StallBound dispatches. Call private.release_stalled_live_poll() in public.dispatch_work before claiming, so a live-poll that never started or stopped renewing is due at once.',
    NoItemRunsTwice:
        'a stale invocation acted on the retry of its item. Keep the lease_token=p_token fence in private.work_finish.',
}

const value = (block, name) => {
    const hit = block.match(new RegExp(String.raw`/\\ ${name} = ([\s\S]*?)(?=\n/\\ |$)`))
    return hit ? hit[1].replace(/\s+/g, ' ').trim() : ''
}
const waits = (text) =>
    [...text.matchAll(/"([^"]+)" :> (\d+)/g)]
        .filter((hit) => hit[2] !== '0')
        .map((hit) => `${hit[1]} waited ${hit[2]}`)
const story = (output) =>
    output
        .split(/\n(?=State \d+:)/)
        .filter((block) => block.startsWith('State '))
        .map((block) => {
            const number = block.match(/^State (\d+):/)[1]
            if (number === '1') return '  1. start.'
            const claims = [...value(block, 'lastClaims').matchAll(/"([^"]+)"/g)].map(
                (hit) => hit[1],
            )
            const counted = Object.entries(
                claims.reduce((all, kind) => ({ ...all, [kind]: (all[kind] ?? 0) + 1 }), {}),
            )
                .map(([kind, count]) => (count > 1 ? `${kind} x${count}` : kind))
                .join(', ')
            const late = waits(value(block, 'wait'))
            return `  ${number}. ${value(block, 'holders')} long worker(s) hold slots; claimed ${counted || 'nothing'}; live-poll ${value(block, 'lp').replaceAll('"', '')}${value(block, 'lpGap') !== '0' ? `, ${value(block, 'lpGap')} dispatch(es) since it was lost` : ''}${late.length ? `; ${late.join(', ')}` : ''}${value(block, 'twice') === 'TRUE' ? '; the lost invocation woke and finished the retry' : ''}.`
        })
        .join('\n')

const only = process.argv.find((arg) => arg.startsWith('--run='))?.slice(6)
const scratch = mkdtempSync(path.join(tmpdir(), 'pancake-work-queue-'))
let failed = false
try {
    for (const run of coverage.runs.filter((run) => !only || run.name === only)) {
        if (
            run.rev &&
            spawnSync('git', ['cat-file', '-e', `${run.rev}^{commit}`], { cwd: repo }).status !== 0
        ) {
            failed = true
            console.log(
                `FAIL ${run.name}: this clone lacks ${run.rev}. Fetch full history with git fetch --unshallow.`,
            )
            continue
        }
        let rules
        try {
            rules = rulesAt(run.rev ?? null)
        } catch (error) {
            failed = true
            console.log(`FAIL ${run.name}: ${error.message}`)
            continue
        }
        const scenario = coverage.scenarios[run.scenario]
        const cfg = path.join(scratch, `${run.name}.cfg`)
        writeFileSync(cfg, config({ ...rules, ...run.mutate }, scenario, run.invariants))
        const result = spawnSync(
            java,
            [
                `-Djava.io.tmpdir=${scratch}`,
                '-XX:+UseParallelGC',
                '-cp',
                jar,
                'tlc2.TLC',
                '-workers',
                run.expect === 'pass' ? 'auto' : '1',
                '-nowarning',
                '-metadir',
                path.join(scratch, run.name),
                '-config',
                cfg,
                'WorkQueue.tla',
            ],
            {
                cwd: here,
                encoding: 'utf8',
            },
        )
        const output = `${result.stdout}${result.stderr}`
        const violated = output.match(/Invariant (\w+) is violated/)?.[1] ?? null
        const passed = result.status === 0 && output.includes('No error has been found')
        const states = output.match(/(\d+) distinct states found, 0 states left on queue/)?.[1]
        const last = output.split(/\n(?=State \d+:)/).at(-1)
        const starved = run.starved
            ? new RegExp(`"${run.starved}" :> ${scenario.FairBound + 1}\\b`).test(
                  value(last ?? '', 'wait'),
              )
            : true
        const ok = run.expect === 'pass' ? passed : violated === run.expect && starved
        failed ||= !ok
        const source = `${run.rev ? `rules at ${run.rev}` : 'rules in this tree'}${run.mutate ? ` with ${JSON.stringify(run.mutate)}` : ''}`
        const expected =
            run.expect === 'pass'
                ? 'no violation'
                : `${run.expect} violated${run.starved ? ` by ${run.starved}` : ''}`
        console.log(
            `${ok ? 'ok' : 'FAIL'} ${run.name} (${source}): ${passed ? `no violation in ${states} states` : violated ? `${violated} violated` : 'TLC error'} (expected ${expected})`,
        )
        if (violated) {
            console.log(story(output))
            console.log(
                `  ${violated}: ${fixes[violated]}${run.fixedBy ? ` History: ${run.fixedBy} fixed this.` : ''}`,
            )
        }
        if (!passed && !violated) console.log(output)
    }
} finally {
    rmSync(scratch, { recursive: true, force: true })
}

if (
    spawnSync('git', ['cat-file', '-e', `${coverage.syncCommit}^{commit}`], { cwd: repo })
        .status !== 0
) {
    fail(`This clone lacks syncCommit ${coverage.syncCommit}. Fetch it with git fetch --unshallow.`)
}
const changed = execFileSync(
    'git',
    ['diff', '--name-only', coverage.syncCommit, '--', ...coverage.files],
    { cwd: repo, encoding: 'utf8' },
).trim()
if (changed) {
    failed = true
    console.log(
        `FAIL covered claim code changed since ${coverage.syncCommit}:\n${changed}\nThe current run above reads the new rules. Check that WorkQueue.tla and extract.mjs still describe them, then set syncCommit in tools/formal/work-queue/coverage.json to the new commit.`,
    )
}
process.exit(failed ? 1 : 0)
