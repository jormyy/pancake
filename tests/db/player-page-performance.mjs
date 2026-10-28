import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { databaseTarget } from '../../scripts/mutation/waivers/targets.mjs'

export const assertIdenticalSnapshots = (before, after) => assert.deepEqual(after, before, 'Screen JSON must remain identical')

const main = () => {
    const { values } = parseArgs({ options: { baseline: { type: 'string' }, migration: { type: 'string' }, output: { type: 'string' } } })
    const target = databaseTarget()
    const query = sql => execFileSync('psql', [target.href, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
        input: sql, encoding: 'utf8', timeout: 1200000, maxBuffer: 64 * 1024 * 1024,
    })
    const inputs = JSON.parse(query(`SELECT to_jsonb(input) FROM (
        SELECT member.league_id, member.id AS member_id, member.user_id, season.id AS season_id, season.season_year,
            (SELECT roster.player_id FROM public.roster_players roster
             JOIN analytics.player_season_totals totals ON totals.player_id=roster.player_id
             WHERE roster.member_id=member.id AND roster.league_season_id=season.id
             ORDER BY totals.games_played DESC, roster.player_id LIMIT 1) AS player_id
        FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id
        JOIN public.league_seasons season ON season.league_id=league.id AND season.is_current
        WHERE league.deleted_at IS NULL
        ORDER BY (SELECT count(*) FROM public.roster_players roster WHERE roster.member_id=member.id
            AND roster.league_season_id=season.id) DESC, member.id LIMIT 1
    ) input;`))
    for (const key of ['league_id', 'member_id', 'user_id', 'season_id', 'player_id']) {
        assert.match(inputs[key], /^[0-9a-f-]{36}$/)
    }
    assert.ok(Number.isInteger(inputs.season_year))
    const league = `'${inputs.league_id}'::uuid`
    const member = `'${inputs.member_id}'::uuid`
    const player = `'${inputs.player_id}'::uuid`
    const year = inputs.season_year
    const playerCall = params => `SELECT public.view_player(${league},${member},'${JSON.stringify({ playerId: inputs.player_id, ...params })}'::jsonb)`
    const tableCall = call => `SELECT COALESCE(jsonb_agg(to_jsonb(row)), '[]'::jsonb) FROM ${call} row`
    const cases = {
        view_player: playerCall({ section: 'overview' }),
        view_player_full: playerCall({}),
        get_league_projection_rows: tableCall(`public.get_league_projection_rows(${league},${year})`),
        get_dynasty_forecast_inputs: tableCall(`public.get_dynasty_forecast_inputs(${league},${member},${year})`),
        view_home: `SELECT public.view_home(${league},${member})`,
    }
    const snapshots = {
        ...cases,
        ...Object.fromEntries(['games', 'news', 'history'].map(section => [`player_${section}`, playerCall({ section })])),
        player_previous_season: playerCall({ seasonYear: year - 1 }),
        ...Object.fromEntries(['today', 'week_avg', 'week_total'].map(view => [`projection_${view}`, tableCall(
            `public.get_league_projection_rows(${league},${year},current_date,'${view}',ARRAY[${player}],1,0)`)])),
        projection_page: tableCall(`public.get_league_projection_rows(${league},${year},current_date,'week_total',NULL,10,10)`),
        dynasty_player: tableCall(`public.get_dynasty_forecast_inputs(${league},${member},${year},ARRAY[${player}])`),
        dynasty_previous_season: tableCall(`public.get_dynasty_forecast_inputs(${league},${member},${year - 1},ARRAY[${player}])`),
        dynasty_search: tableCall(`public.get_dynasty_forecast_inputs(${league},${member},${year},NULL,'a',10,10)`),
        dynasty_denied: tableCall(`public.get_dynasty_forecast_inputs(${league},'00000000-0000-0000-0000-000000000000',${year})`),
        home_previous_week: `SELECT public.view_home(${league},${member},'{"weekNumber":1}')`,
    }
    const marker = (label, name, kind) => `SELECT 'PERF:${label}:${name}:${kind}';\n`
    const capture = label => Object.entries(snapshots).map(([name, sql]) =>
        marker(label, name, 'snapshot') + sql + ';\n').join('')
    const measure = label => Object.entries(cases).map(([name, sql]) =>
        marker(label, name, 'warmup') + `${sql};\n`.repeat(3) +
        Array.from({ length: 20 }, () => marker(label, name, 'plan') +
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql};\n`).join('')).join('')
    let sql = `BEGIN; SET LOCAL statement_timeout='120s';
        ${values.baseline ? readFileSync(values.baseline, 'utf8') : ''}
        SELECT set_config('request.jwt.claim.sub','${inputs.user_id}',true);
        SELECT set_config('request.jwt.claims','{"sub":"${inputs.user_id}","role":"authenticated"}',true);
        SET LOCAL ROLE authenticated;\n`
    sql += capture('before') + measure('before')
    if (values.migration) {
        sql += `RESET ROLE;\n${readFileSync(values.migration, 'utf8')}\nSET LOCAL ROLE authenticated;\n`
        sql += capture('after') + measure('after')
    }
    sql += 'ROLLBACK;\n'
    const output = query(sql)
    const result = { inputs, summaries: {}, plans: {}, snapshots: {} }
    for (const section of output.split(/^PERF:/m).slice(1)) {
        const end = section.indexOf('\n')
        const [label, name, kind] = section.slice(0, end).trim().split(':')
        if (kind === 'warmup') continue
        const value = JSON.parse(section.slice(end + 1).trim())
        result[kind === 'plan' ? 'plans' : 'snapshots'][label] ??= {}
        if (kind === 'snapshot') result.snapshots[label][name] = value
        else (result.plans[label][name] ??= []).push(value[0])
    }
    for (const [label, plans] of Object.entries(result.plans)) {
        result.summaries[label] = Object.fromEntries(Object.entries(plans).map(([name, rows]) => {
            const timings = rows.map(row => row['Execution Time']).sort((a, b) => a - b)
            assert.equal(timings.length, 20)
            return [name, { p50: timings[9], p95: timings[18], max: timings[19],
                sharedHits: rows[19].Plan['Shared Hit Blocks'], sharedReads: rows[19].Plan['Shared Read Blocks'] }]
        }))
    }
    if (values.output) writeFileSync(values.output, JSON.stringify(result, null, 2) + '\n')
    if (values.migration) assertIdenticalSnapshots(result.snapshots.before, result.snapshots.after)
    console.log(JSON.stringify(result.summaries, null, 2))
    console.log(`Snapshots: ${Object.keys(snapshots).length}; identical: ${Boolean(values.migration)}`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main()
