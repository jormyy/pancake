import { access, rm } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { labRoot, project, json } from './common.mjs'
import { withLocalDatabase } from './local-stack.mjs'
import { sql } from './database.mjs'
import { startPrivateEdge } from './runtime.mjs'
import { restoreFixtureCalendar } from './fixture-calendar.mjs'

let stopping = false
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { stopping = true })
await rm(path.join(labRoot, 'stop'), { force: true })
await withLocalDatabase(async () => {
    if (stopping) return
    const calendar = JSON.parse(await sql('SELECT json_agg(week) FROM season_weeks week;'))
    const slate = JSON.parse(await sql(`SELECT coalesce(json_agg(r),'[]') FROM (SELECT id,game_time,status,started_at FROM nba_games
        WHERE game_date BETWEEN (now() AT TIME ZONE 'America/New_York')::date-1 AND (now() AT TIME ZONE 'America/New_York')::date) r;`))
    await sql(`UPDATE nba_games SET game_time=now()+interval '1 day',started_at=NULL,status='Scheduled'
        WHERE game_date BETWEEN (now() AT TIME ZONE 'America/New_York')::date-1 AND (now() AT TIME ZONE 'America/New_York')::date;`)
    const edge = await startPrivateEdge(path.join(labRoot, 'evidence'))
    const nativeFetch = globalThis.fetch
    try {
        globalThis.fetch = async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input))
            if (url.pathname === '/rest/v1/player_game_stats' && init?.method === 'POST' && typeof init.body === 'string') {
                const rows = JSON.parse(init.body)
                if (Array.isArray(rows) && rows.length > 4) {
                    let result
                    for (let offset = 0; offset < rows.length; offset += 4) {
                        result = await globalThis.fetch(input, { ...init, body: JSON.stringify(rows.slice(offset, offset + 4)) })
                        if (!result.ok) return result
                    }
                    return result
                }
            }
            for (let attempt = 0; ; attempt++) {
                const response = await nativeFetch(input, init)
                const body = !response.ok ? await response.clone().json().catch(() => null) : null
                if (!['55P03', '57014'].includes(body?.code) || attempt >= 5) return response
                console.log(`Retrying fixture write ${attempt + 1}: ${url.pathname}`)
                await delay(200 * 2 ** attempt)
            }
        }
        const { seed } = await import('../../../scripts/ios-sim/seed.mjs')
        console.log('Seeding synthetic managers and the live game.')
        const fixture = await seed({ stack: { url: edge.keys.API_URL, serviceKey: edge.keys.SERVICE_ROLE_KEY, anonKey: edge.keys.ANON_KEY, project }, snapshot: process.cwd(), directory: path.join(labRoot, 'seed') })
        await json(path.join(labRoot, 'seed/complete.json'), await restoreFixtureCalendar(calendar, fixture))
        await sql(`UPDATE nba_games game SET game_time=restored.game_time,status=restored.status,started_at=restored.started_at
            FROM jsonb_populate_recordset(NULL::public.nba_games,'${JSON.stringify(slate).replaceAll("'", "''")}'::jsonb) restored WHERE game.id=restored.id;`)
        await sql("UPDATE players SET nba_id=NULL WHERE sportsdata_id LIKE 'ios-sim-%' OR sportsdata_id LIKE 'e2e-player-%';")
        globalThis.fetch = nativeFetch
        await json(path.join(labRoot, 'ready.json'), { project, leagueId: fixture.leagueId, started: new Date().toISOString() })
        console.log('Local PWA stack ready with the production database limits.')
        const deadline = Date.now() + 360 * 60000
        while (!stopping && Date.now() < deadline && await access(path.join(labRoot, 'stop')).then(() => false, () => true)) await delay(1000)
    } finally { globalThis.fetch = nativeFetch; await edge.close() }
})
