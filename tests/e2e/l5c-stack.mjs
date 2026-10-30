import assert from 'node:assert/strict'
import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { labRoot, requireMini } from '../../scripts/perf-lab/common.mjs'
import { withDatabase } from '../../scripts/perf-lab/setup.mjs'
import { startEdge, seedScreens } from '../../scripts/perf-lab/runtime.mjs'
import { sql } from '../../scripts/perf-lab/database.mjs'
import { certificate, buildWeb } from '../../scripts/perf-lab/build.mjs'
import { captureServer } from '../../scripts/perf-lab/capture.mjs'

await requireMini()
assert.equal(process.env.PERF_LAB_PROJECT, 'pt4bafablerq')
assert.equal(process.env.PERF_LAB_PORT_PREFIX, '633')
await mkdir(path.join(labRoot, 'backup'), { recursive: true })
await withDatabase(async ({ evidence }) => {
    let edge, server
    try {
        edge = await startEdge(evidence)
        await sql(`BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
      SELECT 2027,n,date_trunc('week',now() AT TIME ZONE 'America/New_York')::date+(n-1)*7,
        date_trunc('week',now() AT TIME ZONE 'America/New_York')::date+(n-1)*7+6 FROM generate_series(1,26) n
      ON CONFLICT(season_year,week_number) DO UPDATE SET week_start=EXCLUDED.week_start,week_end=EXCLUDED.week_end;
      COMMIT;`)
        const nativeFetch = globalThis.fetch
        globalThis.fetch = (input, init) => {
            const request = new Request(input, init)
            const url = new URL(request.url)
            if (
                url.origin === edge.keys.API_URL &&
                url.pathname === '/rest/v1/season_weeks' &&
                request.method === 'POST'
            )
                return Promise.resolve(Response.json([]))
            return nativeFetch(input, init)
        }
        let stack
        try {
            for (let attempt = 0; !stack; attempt++) {
                try {
                    stack = await seedScreens(edge.keys)
                } catch (error) {
                    console.error(`Fixture attempt ${attempt + 1}: ${error.message}`)
                    console.log(
                        await sql(
                            "SELECT json_agg(r) FROM (SELECT pid,state,wait_event_type,wait_event,left(query,200) AS query FROM pg_stat_activity WHERE datname='postgres' AND pid<>pg_backend_pid()) r",
                        ),
                    )
                    if (attempt >= 2) throw error
                    await delay(5000)
                }
            }
        } finally {
            globalThis.fetch = nativeFetch
        }
        const tls = await certificate()
        const build = await buildWeb(edge.keys, tls)
        server = await captureServer({ root: build.root, evidence, ...tls })
        await writeFile(
            path.join(labRoot, 'ready.json'),
            JSON.stringify({ origin: tls.origin, fixture: stack.fixture }),
        )
        console.log('L5c ready')
        while (
            !(await access(path.join(labRoot, 'stop')).then(
                () => true,
                () => false,
            ))
        )
            await delay(1000)
    } finally {
        await server?.close()
        await edge?.close()
    }
})
