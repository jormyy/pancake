#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../..')
const byName = 'supabase/sql/functions/by-name'

const sources = {
    claim: `${byName}/private/work_claim.sql`,
    dispatch: `${byName}/public/dispatch_work.sql`,
    release: `${byName}/private/release_stalled_live_poll.sql`,
    finish: `${byName}/private/work_finish.sql`,
}

const read = (rev, file) => {
    if (rev === null)
        return existsSync(path.join(repo, file))
            ? readFileSync(path.join(repo, file), 'utf8')
            : null
    try {
        return execFileSync('git', ['show', `${rev}:${file}`], {
            cwd: repo,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        })
    } catch {
        return null
    }
}

const kinds = (list) => [...list.matchAll(/'([^']+)'/g)].map((hit) => hit[1])
const ticks = (amount, unit) =>
    Math.ceil((Number(amount) * (unit.startsWith('minute') ? 60 : 1)) / 60)
const runningCount = String.raw`\(SELECT count\(\*\) FROM private\.work_items WHERE status='running' AND lease_until>clock_timestamp\(\)\)`

export const rulesAt = (rev) => {
    const text = Object.fromEntries(
        Object.entries(sources).map(([name, file]) => [name, read(rev, file)]),
    )
    const where = rev ?? 'the working tree'
    const need = (value, what) => {
        if (value === undefined || value === null) {
            throw new Error(
                `extract.mjs cannot read ${what} from ${where}. Update extract.mjs and WorkQueue.tla to the new claim rules before trusting this check.`,
            )
        }
        return value
    }
    const claim = need(text.claim, sources.claim)
    const dispatch = need(text.dispatch, sources.dispatch)
    const finish = need(text.finish, sources.finish)

    const capHit = claim.match(/least\(p_limit,(\d+)-\(SELECT count/)
    const uncapped = /least\(p_limit,500\)/.test(claim)
    const cap = capHit
        ? Number(capHit[1])
        : need(uncapped ? 1000 : null, 'the running cap in work_claim')
    const perDispatch = Number(
        need(dispatch.match(/v_count>=(\d+)/)?.[1], 'the claim loop count limit in dispatch_work'),
    )
    const background = kinds(
        claim.match(/ELSE item\.kind IN\s*\(([^)]*)\) END AS background/)?.[1] ??
            claim.match(/ORDER BY \(item\.kind IN \(([^)]*)\)\)/)?.[1] ??
            '',
    )
    const rotate = /last_claimed_at END NULLS FIRST/.test(claim)
    const rotation = rotate
        ? kinds(
              need(
                  claim.match(
                      /IF v_item\.kind IN\(([^)]*)\) THEN\s*UPDATE private\.work_kinds SET last_claimed_at/,
                  )?.[1],
                  'the rotation kind list in work_claim',
              ),
          )
        : []
    const gateHit =
        claim.match(new RegExp(String.raw`kind NOT IN\(([^)]*)\) OR\s*${runningCount}<(\d+)`)) ??
        claim.match(
            new RegExp(
                String.raw`IF v_item\.kind IN\(([^)]*)\) AND\s*${runningCount}>=(\d+) THEN CONTINUE`,
            ),
        )
    const lease = need(
        claim.match(
            /lease_until=(?:now|clock_timestamp)\(\)\+(?:CASE WHEN item\.kind='[^']+' THEN interval '[^']+' ELSE )?interval '(\d+) (seconds|minutes)'/,
        ),
        'the claim lease in work_claim',
    )
    const leaseSeconds = Number(lease[1]) * (lease[2] === 'minutes' ? 60 : 1)
    const backoff = Number(
        need(finish.match(/least\(900,(\d+)\*power/)?.[1], 'the retry backoff in work_finish'),
    )
    const stallRelease =
        /PERFORM private\.release_stalled_live_poll\(\)/.test(dispatch) && text.release !== null
    const renewWindow = stallRelease
        ? Number(
              need(
                  text.release.match(
                      /item\.lease_until<=clock_timestamp\(\)\+interval '(\d+) seconds'/,
                  )?.[1],
                  'the renewal window in release_stalled_live_poll',
              ),
          )
        : 0

    return {
        Cap: cap,
        PerDispatch: perDispatch,
        LiveFirst: /ORDER BY CASE WHEN item\.kind='live-poll' THEN 0/.test(claim),
        Background: background,
        MatchupDynamic: /CASE WHEN item\.kind='matchup-forecasts' THEN/.test(claim),
        Rotate: rotate,
        RotationKinds: rotation,
        GateKinds: gateHit ? kinds(gateHit[1]) : [],
        Gate: gateHit ? Number(gateHit[2]) : cap,
        LeaseTicks: ticks(leaseSeconds, 'seconds'),
        BackoffTicks: ticks(backoff, 'seconds'),
        StallRelease: stallRelease,
        ReleaseAfter: stallRelease ? Math.max(1, ticks(leaseSeconds - renewWindow, 'seconds')) : 0,
        Fenced: /status='running' AND lease_token=p_token/.test(finish),
    }
}

const tla = (value) =>
    Array.isArray(value)
        ? `{${value.map((item) => JSON.stringify(item)).join(', ')}}`
        : typeof value === 'boolean'
          ? String(value).toUpperCase()
          : String(value)

export const config = (rules, scenario, invariants) =>
    [
        'SPECIFICATION Spec',
        'CONSTANTS',
        ...Object.entries({ ...rules, ...scenario }).map(
            ([name, value]) => `  ${name} = ${tla(value)}`,
        ),
        ...invariants.map((name) => `INVARIANT ${name}`),
        '',
    ].join('\n')

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    console.log(JSON.stringify(rulesAt(process.argv[2] ?? null), null, 2))
}
