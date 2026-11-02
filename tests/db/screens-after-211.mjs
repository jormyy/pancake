import { evidencePath } from '../helpers/evidence-path.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { command } from '../../scripts/perf-lab/process.mjs'

Object.assign(process.env, { PERF_LAB_ON_MINI: '1', PERF_LAB_LANE: 'fable-ui27', PERF_LAB_PROJECT: 'pt4bafablesr', PERF_LAB_PORT_PREFIX: '642', SCREEN_COST_EVIDENCE: 'screens-after-211-evidence' })
const { literal, load, save, plans } = await import('./screen-view-costs.mjs')
const { measure, run, jsonValues } = await import('./unpartition-player-stats.mjs')
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const label = option('label') ?? '211'
const migrationFile = 'supabase/migrations/20261214003900_screens_after_211.sql'
const candidate = await readFile(migrationFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
const baselineFiles = ['public/view_players.sql', 'public/view_player.sql', 'public/view_trade_block.sql', 'public/view_home.sql', 'public/view_trades.sql', 'public/view_roster.sql', 'private/locked_assets.sql', 'public/get_trade_cards.sql']
const baseline = process.argv.includes('--baseline') || process.argv.includes('--release') ? (await Promise.all(baselineFiles.map(async file => (await command('git', ['show', `${process.argv.includes('--release') ? '1e696f25' : '892b6bca'}:supabase/sql/functions/by-name/${file}`])).stdout))).join('\n') : ''
const definition = baseline || (process.argv.includes('--candidate') ? candidate.replace(/^BEGIN;\s*/, '').replace(/\s*COMMIT;\s*$/, '') : '')
await command('docker', ['update', '--cpus=1', '--memory=1g', '--memory-swap=1g', 'supabase_db_pt4bafablesr'])

async function inventory() {
  const result = await run(`WITH chosen AS (SELECT l.id FROM public.leagues l JOIN public.roster_players r ON r.league_id=l.id WHERE l.deleted_at IS NULL GROUP BY l.id ORDER BY count(*) DESC,l.id LIMIT 1)
SELECT jsonb_build_object('league',c.id,'members',(SELECT jsonb_agg(to_jsonb(m)) FROM (SELECT id,user_id FROM public.league_members WHERE league_id=c.id AND user_id IS NOT NULL ORDER BY id LIMIT 3) m),
'player',(SELECT player_id FROM public.player_game_stats GROUP BY player_id ORDER BY count(*) DESC,player_id LIMIT 1),
'dates',jsonb_build_array((SELECT max(game_date) FROM public.player_game_stats),(SELECT d::date FROM generate_series(current_date-30,current_date,'1 day') d WHERE NOT EXISTS(SELECT 1 FROM public.nba_games g WHERE g.game_date=d::date) ORDER BY d DESC LIMIT 1)),
'matchup',(SELECT id FROM public.matchups WHERE league_id=c.id AND NOT is_voided ORDER BY week_number,id LIMIT 1),
'trade',(SELECT to_jsonb(t) FROM (SELECT t.id,t.league_id,m.id AS member,m.user_id AS "user" FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id WHERE t.league_id=c.id ORDER BY (SELECT count(*) FROM public.trade_items WHERE trade_id=t.id) DESC,t.id LIMIT 1) t)) FROM chosen c;`)
  const fixture = JSON.parse(result.stdout)
  assert.equal(fixture.members.length, 3)
  assert.ok(fixture.player && fixture.trade && fixture.dates.every(Boolean))
  await save('fixture.json', fixture)
  console.log('Fixture: three managers, live and off-day dates, historical player, restored trade.')
}

async function recompute() {
  const { syncTradeValues } = await import('../../supabase/functions/_shared/tradeValues.ts')
  const { analyzeTradeEstimate } = await import('../../supabase/functions/_shared/tradeEstimate.ts')
  const json = async query => { const output = (await run(query)).stdout.trim(); return output === 't' ? true : output === 'f' ? false : JSON.parse(output) }
  const players = await json('SELECT jsonb_agg(row) FROM (SELECT id,display_name,nba_team,position,eligible_positions FROM public.players) row;')
  const forbidden = async () => { throw new Error('Offline replay cannot fetch source data') }
  const imported = await syncTradeValues({ claim: forbidden, fail: forbidden, cached: forbidden, players: async () => players, overrides: async () => ({}),
    publish: async payload => json(`SELECT public.publish_trade_values(${literal(JSON.stringify(payload.rows))}::jsonb,${literal(JSON.stringify(payload.picks))}::jsonb,${literal(payload.source)},${literal(payload.fetchedAt)}::timestamptz,${literal(payload.mode)});`),
  }, { format: 'json', content: await readFile('tests/fixtures/trade-values/onenumberhoops.json', 'utf8') })
  let saved = 0
  for (;;) {
    const batch = await json("SELECT COALESCE(jsonb_agg(id),'[]') FROM public.get_trade_estimate_reanalysis_batch() id;")
    if (!batch.length) break
    for (const id of batch) {
      const inputs = await json(`SELECT public.get_trade_estimate_reanalysis_inputs(${literal(id)});`)
      const analysis = analyzeTradeEstimate(inputs, Date.parse(inputs.observedAt))
      await run(`SELECT public.save_trade_estimate_reanalysis(${literal(id)},${literal(JSON.stringify(inputs))}::jsonb,${literal(JSON.stringify(analysis))}::jsonb);`)
      saved++
    }
  }
  const trades = await json("SELECT jsonb_agg(row) FROM (SELECT t.id,t.league_id,t.league_season_id,m.id AS member,m.user_id AS actor FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id WHERE t.status IN('pending','accepted')) row;")
  for (const trade of trades) {
    const inputs = await json(`SELECT public.get_trade_revaluation_inputs(${literal(trade.actor)}::uuid,${literal(trade.member)}::uuid,${literal(trade.id)}::uuid);`)
    const revaluation = { tradeId: trade.id, modelVersion: 'onenumber-trade-curve-v6', inputVersion: inputs.inputVersion, createdAt: inputs.observedAt, expiresAt: new Date(Date.parse(inputs.observedAt) + 600000).toISOString(), seasonYear: inputs.seasonYear, terms: inputs.terms, analysis: analyzeTradeEstimate(inputs, Date.parse(inputs.observedAt)) }
    assert.equal(await json(`SELECT private.refresh_trade_values(${literal(trade.league_id)}::uuid,${literal(trade.league_season_id)}::uuid,(SELECT version FROM private.screen_refresh_queue WHERE league_season_id=${literal(trade.league_season_id)}::uuid),${literal(JSON.stringify([{ tradeId: trade.id, revaluation }]))}::jsonb);`), true)
  }
  await run('ANALYZE;')
  await save('recompute.json', { imported, saved, published: trades.length })
  console.log(JSON.stringify({ imported, saved, published: trades.length }))
}

function workload(f, variants = false) {
  const rows = []
  for (const member of f.members) {
    const add = (name, params, variant = JSON.stringify(params), setup = '') => rows.push({ name, variant, member: member.id, user: member.user_id, role: 'authenticated', setup, expression: `public.${name}(${literal(f.league)}::uuid,${literal(member.id)}::uuid,${literal(JSON.stringify(params))}::jsonb)` })
    for (const name of ['view_players', 'view_trades', 'view_trade_block', 'view_player', 'view_home']) {
      const base = name === 'view_player' ? { playerId: f.player } : {}
      add(name, base, 'default')
      if (variants) {
        for (const date of f.dates) add(name, { ...base, date })
        if (name === 'view_players') for (const params of [{ availability: 'free_agents' }, { availability: 'mine' }, { availability: 'rostered' }, { availability: 'available' }, { availability: 'waivers' }, { sortBy: 'name', limit: 50 }, { query: 'James' }, { sortBy: 'projection' }, { includePlayerIds: [f.player] }]) add(name, params)
        if (name === 'view_trades') add(name, { tab: 'history' })
        if (name === 'view_trade_block') add(name, { blockOnly: true })
        if (name === 'view_player') for (const params of [{ section: 'games', seasonYear: 2025, gameLimit: 100 }, { section: 'overview' }, { section: 'news' }, { section: 'history' }]) add(name, { ...base, ...params })
      }
    }
  }
  const blockSetup = `SET LOCAL session_replication_role=replica;
INSERT INTO public.trade_block_items(id,league_id,member_id,player_id)
SELECT md5('screens211-block-'||r.id)::uuid,r.league_id,r.member_id,r.player_id FROM public.roster_players r
JOIN public.league_seasons season ON season.id=r.league_season_id AND season.is_current
WHERE r.league_id=${literal(f.league)}::uuid ORDER BY r.id LIMIT 40 ON CONFLICT DO NOTHING;
SET LOCAL session_replication_role=origin;`
  if (process.argv.includes('--populated') || variants) for (const member of f.members) for (const name of ['view_trade_block', 'view_trades']) rows.push({ name, variant: 'populated-block', member: member.id, user: member.user_id, role: 'authenticated', setup: blockSetup, expression: `public.${name}(${literal(f.league)}::uuid,${literal(member.id)}::uuid,'{}'::jsonb)` })
  const t = f.trade
  const setup = `SET LOCAL session_replication_role=replica;
INSERT INTO public.trades SELECT (jsonb_populate_record(NULL::public.trades,to_jsonb(t)||jsonb_build_object('id',md5('screens211-'||n)::uuid,'status','pending','proposed_at',now()-n*interval '1 second'))).* FROM public.trades t CROSS JOIN generate_series(1,40) n WHERE t.id=${literal(t.id)}::uuid ON CONFLICT DO NOTHING;
INSERT INTO public.trade_participants SELECT (jsonb_populate_record(NULL::public.trade_participants,to_jsonb(p)||jsonb_build_object('trade_id',md5('screens211-'||n)::uuid,'proposed_at',now()-n*interval '1 second'))).* FROM public.trade_participants p CROSS JOIN generate_series(1,40) n WHERE p.trade_id=${literal(t.id)}::uuid ON CONFLICT DO NOTHING;
INSERT INTO public.trade_items SELECT (jsonb_populate_record(NULL::public.trade_items,to_jsonb(i)||jsonb_build_object('id',md5('screens211-item-'||i.id||'-'||n)::uuid,'trade_id',md5('screens211-'||n)::uuid))).* FROM public.trade_items i CROSS JOIN generate_series(1,40) n WHERE i.trade_id=${literal(t.id)}::uuid ON CONFLICT DO NOTHING;
INSERT INTO public.trade_estimates SELECT (jsonb_populate_record(NULL::public.trade_estimates,to_jsonb(e)||jsonb_build_object('trade_id',md5('screens211-'||n)::uuid))).* FROM public.trade_estimates e CROSS JOIN generate_series(1,40) n WHERE e.trade_id=${literal(t.id)}::uuid ON CONFLICT DO NOTHING;
INSERT INTO public.trade_value_cache SELECT (jsonb_populate_record(NULL::public.trade_value_cache,to_jsonb(c)||jsonb_build_object('trade_id',md5('screens211-'||n)::uuid))).* FROM public.trade_value_cache c CROSS JOIN generate_series(1,40) n WHERE c.trade_id=${literal(t.id)}::uuid ON CONFLICT DO NOTHING;
SET LOCAL session_replication_role=origin;`
  rows.push({ name: 'view_trades', variant: '40-cards', member: t.member, user: t.user, role: 'authenticated', setup, expression: `public.view_trades(${literal(f.league)}::uuid,${literal(t.member)}::uuid,'{}'::jsonb)` })
  return rows.filter(row => !option('function') || option('function').split(',').includes(row.name))
}

async function prepare(row) {
  if (row.setup) await run('VACUUM (ANALYZE) public.trades,public.trade_participants,public.trade_items,public.trade_estimates,public.trade_value_cache,public.trade_block_items;')
}

async function trace(row) {
  await prepare(row)
  const snapshot = phase => `RESET ROLE;SELECT jsonb_build_object('phase','${phase}','statements',COALESCE(jsonb_agg(to_jsonb(s)),'[]')) FROM (SELECT query,toplevel,plans,calls,total_plan_time,total_exec_time,shared_blks_hit+shared_blks_read AS buffers,rows FROM extensions.pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query NOT LIKE '%pg_stat_statements%') s;`
  const prime = Array.from({ length: 5 }, () => `SELECT ${row.expression}\n\\g /dev/null\n`).join('')
  const result = await run(`BEGIN;SET LOCAL statement_timeout='120s';SET LOCAL auto_explain.log_min_duration=-1;${definition}${row.setup}
SET LOCAL request.jwt.claim.sub=${literal(row.user)};SET LOCAL pg_stat_statements.track='all';SET LOCAL pg_stat_statements.track_planning=on;
LOAD 'auto_explain';SET LOCAL auto_explain.log_analyze=on;SET LOCAL auto_explain.log_buffers=on;SET LOCAL auto_explain.log_timing=off;SET LOCAL auto_explain.log_nested_statements=on;SET LOCAL auto_explain.log_format=json;SET LOCAL auto_explain.log_level=notice;SET LOCAL auto_explain.log_parameter_max_length=0;SET LOCAL auto_explain.sample_rate=1;
SELECT extensions.pg_stat_statements_reset();SET LOCAL auto_explain.log_min_duration=0;SET LOCAL ROLE ${row.role};
EXPLAIN(ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) SELECT ${row.expression};${snapshot('fresh')}
SET LOCAL auto_explain.log_min_duration=-1;SET LOCAL ROLE ${row.role};${prime}
RESET ROLE;SELECT extensions.pg_stat_statements_reset();SET LOCAL auto_explain.log_min_duration=0;SET LOCAL ROLE ${row.role};
EXPLAIN(ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) SELECT ${row.expression};${snapshot('warm')}ROLLBACK;`)
  const captured = { values: jsonValues(result.stdout), nested: plans(result.stderr) }
  await save(`${label}-${row.name}-${row.variant === '40-cards' ? 'dense' : `${row.variant === 'populated-block' ? 'block-' : ''}${row.member}`}-trace.json`, captured)
  for (const phase of captured.values.filter(value => value.phase)) console.log(JSON.stringify({ name: row.name, variant: row.variant, phase: phase.phase, top: phase.statements.filter(s => !s.toplevel && !/^EXPLAIN/.test(s.query)).sort((a, b) => b.total_plan_time + b.total_exec_time - a.total_plan_time - a.total_exec_time).slice(0, 5).map(s => ({ query: s.query.slice(0, 170), planning: s.total_plan_time, execution: s.total_exec_time, buffers: s.buffers })) }))
}

async function parity(f) {
  assert.ok(definition)
  const all = workload(f, true)
  const results = []
  const scenarios = [...new Set(all.map(row => row.setup))].map(setup => ({ setup, rows: all.filter(row => row.setup === setup), scenario: 'restored' }))
  for (const [scenario, mutation] of [
    ['legacy-cache', `UPDATE public.trade_value_cache SET revaluation=jsonb_set(revaluation,'{modelVersion}','"legacy-model"');`],
    ['null-analysis', `UPDATE public.trade_value_cache SET revaluation=revaluation||'{"inputVersion":null,"createdAt":null,"analysis":null}'::jsonb;`],
    ['scalar-cache', `UPDATE public.trade_value_cache SET revaluation='[]'::jsonb;`],
  ]) for (const setup of [...new Set(all.filter(row => row.name === 'view_trades' && ['default', '40-cards'].includes(row.variant)).map(row => row.setup))]) scenarios.push({ scenario, setup: setup + mutation, rows: all.filter(row => row.name === 'view_trades' && row.setup === setup && ['default', '40-cards'].includes(row.variant)) })
  for (const { rows, setup, scenario } of scenarios) {
    if (!rows.length) continue
    const record = table => rows.map((row, id) => `SET LOCAL request.jwt.claim.sub=${literal(row.user)};SET LOCAL ROLE authenticated;INSERT INTO ${table} VALUES(${id},(${row.expression})::text);RESET ROLE;`).join('\n')
    const result = await run(`BEGIN;SET LOCAL statement_timeout='120s';SET LOCAL auto_explain.log_min_duration=-1;${setup}
CREATE TEMP TABLE expected(id integer PRIMARY KEY,value text);CREATE TEMP TABLE actual(LIKE expected INCLUDING ALL);GRANT ALL ON expected,actual TO authenticated;
${record('expected')}${definition}${record('actual')}
SELECT jsonb_build_object('count',count(*),'bytes',sum(octet_length(e.value)),'mismatches',COALESCE(jsonb_agg(e.id) FILTER(WHERE e.value IS DISTINCT FROM a.value),'[]')) FROM expected e JOIN actual a USING(id);
UPDATE actual SET value=value||'broken' WHERE id=0;SELECT jsonb_build_object('negative',count(*)) FROM expected e JOIN actual a USING(id) WHERE e.value IS DISTINCT FROM a.value;ROLLBACK;`)
    const [summary, negative] = jsonValues(result.stdout)
    results.push({ scenario, ...summary, ...negative, cases: rows.map(({ name, variant, member }) => ({ name, variant, member })) })
    await save(`${label}-parity.json`, results)
    assert.deepEqual(summary.mismatches, [])
    assert.equal(negative.negative, 1)
    console.log(JSON.stringify({ scenario, ...summary, ...negative }))
  }
}

if (process.argv.includes('--inventory')) await inventory()
else if (process.argv.includes('--recompute')) await recompute()
else {
  const fixture = await load('fixture.json')
  const rows = workload(fixture, process.argv.includes('--variants'))
  if (process.argv.includes('--compare')) {
    assert.ok(candidate)
    const versions = { fixed: candidate.replace(/^BEGIN;\s*/, '').replace(/\s*COMMIT;\s*$/, '') }
    for (const [version, commit] of [['2102', '892b6bca'], ['211', '1e696f25']]) versions[version] = (await Promise.all(baselineFiles.map(async file => (await command('git', ['show', `${commit}:supabase/sql/functions/by-name/${file}`])).stdout))).join('\n')
    const samples = Object.fromEntries(Object.keys(versions).map(version => [version, []]))
    for (let round = 0; round < Number(option('rounds') ?? 5); round++) for (const row of rows) for (const version of round % 2 ? Object.keys(versions).reverse() : Object.keys(versions)) {
      await prepare(row)
      const result = await measure(row, 'postgres', false, versions[version])
      for (const state of ['fresh', 'warm']) samples[version].push({ name: row.name, variant: row.variant, member: row.member, round, state, ...result[state] })
      await save(`comparison-${version}-samples.json`, samples[version])
      console.log(`${round + 1} ${version} ${row.name} ${row.variant}: ${result.fresh.milliseconds.toFixed(2)}/${result.warm.milliseconds.toFixed(2)} ms; ${result.warm.buffers} warm buffers`)
    }
  } else if (process.argv.includes('--capture')) {
    const samples = []
    for (let round = 0; round < Number(option('rounds') ?? 5); round++) for (const row of rows) {
      await prepare(row)
      const result = await measure(row, 'postgres', false, definition)
      for (const state of ['fresh', 'warm']) samples.push({ name: row.name, variant: row.variant, member: row.member, round, state, ...result[state] })
      await save(`${label}-samples.json`, samples)
      console.log(`${round + 1} ${row.name} ${row.variant}: ${result.fresh.milliseconds.toFixed(2)}/${result.warm.milliseconds.toFixed(2)} ms; ${result.warm.buffers} warm buffers`)
    }
  } else if (process.argv.includes('--trace')) {
    for (const row of rows.filter(row => row.member === fixture.members[0].id || row.variant === '40-cards')) await trace(row)
  } else if (process.argv.includes('--parity')) await parity(fixture)
  else if (process.argv.includes('--report')) {
    const summaries = {}
    for (const release of ['2102', '211', 'fixed', 'installed']) {
      const samples = await load(`${release === 'installed' ? '' : 'comparison-'}${release}-samples.json`)
      summaries[release] = [...Map.groupBy(samples, row => `${row.name}/${row.variant}/${row.member}/${row.state}`).values()].map(group => {
        const values = key => group.map(row => row[key]).sort((a, b) => a - b)
        return { name: group[0].name, variant: group[0].variant, member: group[0].member, state: group[0].state, count: group.length, p95: values('milliseconds')[Math.ceil(group.length * .95) - 1], buffers: values('buffers').at(-1) }
      })
    }
    const comparison = summaries.fixed.map(row => {
      const old = summaries['2102'].find(other => other.name === row.name && other.variant === row.variant && other.member === row.member && other.state === row.state)
      assert.ok(old)
      assert.equal(row.count, 5)
      assert.equal(old.count, 5)
      return { name: row.name, variant: row.variant, member: row.member, state: row.state, before: old.buffers, after: row.buffers, passes: row.state === 'fresh' ? row.p95 < 150 : row.buffers <= old.buffers }
    })
    const installed = summaries.installed.filter(row => row.state === 'fresh')
    assert.ok(installed.every(row => row.count === 5 && row.p95 < 150))
    const installedBuffers = summaries.installed.filter(row => row.state === 'warm').flatMap(row => {
      const old = summaries['2102'].find(other => other.name === row.name && other.variant === row.variant && other.member === row.member && other.state === row.state)
      return old ? [{ name: row.name, variant: row.variant, member: row.member, before: old.buffers, after: row.buffers, passes: row.buffers <= old.buffers }] : []
    })
    assert.ok(installedBuffers.every(row => row.passes))
    const parity = await load('final-parity.json')
    assert.ok(parity.every(row => row.mismatches.length === 0 && row.negative === 1))
    assert.ok(comparison.every(row => row.passes))
    const result = { baseline: '892b6bca', release: '1e696f25', migrationSha256: createHash('sha256').update(candidate).digest('hex'), methodology: { cpus: 1, memoryBytes: 1073741824, samplesPerCase: 5, fresh: 'new connection', warm: 'same connection after five priming calls', timing: 'planning plus execution; nested logging disabled', buffers: 'shared hit plus shared read', fixturePreparation: 'vacuum and analyze fixture tables before synthetic samples' }, summaries, comparison, installedBuffers, parity }
    await writeFile(evidencePath('screens-after-211-results.json'), `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify(result))
  } else throw new Error('Choose --inventory, --capture, --trace, --parity, or --report')
}
