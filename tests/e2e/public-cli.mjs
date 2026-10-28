import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

export function backupStatements(data, existing) {
  const statements = []
  for (const match of data.matchAll(/^INSERT INTO "(public|private|analytics)"\."([^"]+)"/gm)) {
    if (!(match[1] === 'public' || (match[1] === 'private' && ['player_espn_listings', 'player_game_memberships'].includes(match[2]))
      || (match[1] === 'analytics' && match[2] === 'player_season_totals'))
      || !existing.includes(`${match[1]}.${match[2]}`)) continue
    let quoted = false
    for (let index = match.index; index < data.length; index++) {
      if (data[index] === "'") {
        if (quoted && data[index + 1] === "'") { index++; continue }
        quoted = !quoted
      } else if (!quoted && data[index] === ';') {
        statements.push([data.slice(match.index, index + 1), match[1], match[2]])
        break
      }
    }
  }
  return statements
}

async function main() {

const args = Object.fromEntries(process.argv.slice(2).map(value => value.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)))
if (!args.env) throw new Error('Supply the private stack environment file with --env')
const environment = Object.fromEntries(readFileSync(args.env, 'utf8').split('\n').flatMap(line => {
  const match = /^([A-Z_]+)="(.*)"$/.exec(line)
  return match ? [[match[1], match[2]]] : []
}))
const database = new URL(environment.DB_URL)
const api = new URL(environment.API_URL)
const config = readFileSync('supabase/config.toml', 'utf8')
assert.equal(database.hostname, '127.0.0.1')
assert.equal(database.port, '58922')
assert.equal(api.hostname, '127.0.0.1')
assert.equal(api.port, '58921')
assert.match(config, /project_id = "pt4bafableux"/)
const sql = query => execFileSync('psql', [database.href, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: query, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const decode = filename => filename.endsWith('.gz') ? gunzipSync(readFileSync(filename)).toString() : readFileSync(filename, 'utf8')
if (args.restore) {
  const data = decode(args.restore)
  const existing = JSON.parse(sql("SELECT json_agg(table_schema || '.' || table_name) FROM information_schema.tables WHERE table_schema IN ('public','private','analytics')"))
  const inserts = backupStatements(data, existing)
  assert.ok(inserts.length > 40, 'The backup is incomplete')
  const tables = inserts.map(match => `"${match[1]}"."${match[2]}"`)
  const restore = `BEGIN; SET LOCAL session_replication_role = replica; SELECT cron.unschedule(jobid) FROM cron.job; TRUNCATE ${tables.join(',')} CASCADE;\n${inserts.map(match => match[0]).join('\n')}\nINSERT INTO auth.users(id,aud,role) SELECT id,'authenticated','authenticated' FROM public.profiles ON CONFLICT(id) DO NOTHING; COMMIT;`
  sql(restore)
  console.log(JSON.stringify({ restoredTables: inserts.length, publicLeagues: Number(sql('SELECT count(*) FROM public.leagues')), cronDisabled: sql('SELECT count(*) FROM cron.job') === '0' }))
  process.exit(0)
}
if (args['edge-env']) {
  writeFileSync(args['edge-env'], `PANCAKE_SUPABASE_SECRET_KEY=${environment.SECRET_KEY ?? environment.SERVICE_ROLE_KEY}\n`, { mode: 0o600 })
  console.log('Private Edge environment prepared')
  process.exit(0)
}
execFileSync('psql', [database.href, '-X', '-v', 'ON_ERROR_STOP=1', '-f', 'tests/db/public-cli.sql'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const context = JSON.parse(sql(`SELECT json_build_object('league',m.league_id,'owner',m.user_id,'team',m.id) FROM public.league_members m JOIN public.leagues l ON l.id=m.league_id AND l.deleted_at IS NULL WHERE m.role='commissioner' ORDER BY m.league_id LIMIT 1`))
const credentials = JSON.parse(sql(`BEGIN; SELECT set_config('request.jwt.claim.sub','${context.owner}',true); SELECT public.public_share_token('${context.league}', 'rotate'); COMMIT;`).split('\n').at(-1))
const token = credentials.token
const base = `${api.href.replace(/\/$/, '')}/functions/v1/api`
const call = (resource, init = {}, query = '') => fetch(`${base}/public/v1/${resource}${query}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } })
const operator = JSON.parse(execFileSync(process.execPath, ['packages/pancake-cli/bin/pancake.mjs', 'db-health', '--operator-connection', database.href, '--json'], { encoding: 'utf8' }))
assert.equal(operator.private, true)
assert.ok(Array.isArray(operator.report.tables))
const counts = {}
const drafts = { snake: randomUUID(), auction: randomUUID(), nomination: randomUUID() }
let seededDrafts = false
try {
  sql(`BEGIN; SET LOCAL session_replication_role=replica;
    INSERT INTO public.drafts(id,league_id,league_season_id,draft_type,status,is_mock,started_at,completed_at,rounds)
      SELECT '${drafts.snake}','${context.league}',id,'snake','completed',false,now(),now(),1 FROM public.league_seasons WHERE league_id='${context.league}' AND is_current;
    INSERT INTO public.drafts(id,league_id,league_season_id,draft_type,status,is_mock,started_at,completed_at,rounds)
      SELECT '${drafts.auction}','${context.league}',id,'auction','completed',false,now(),now(),1 FROM public.league_seasons WHERE league_id='${context.league}' AND is_current;
    INSERT INTO public.snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,player_id,picked_at)
      SELECT '${drafts.snake}',1,1,1,'${context.team}',id,now() FROM public.players ORDER BY id LIMIT 1;
    INSERT INTO public.nominations(id,draft_id,player_id,nominating_member_id,status,winning_member_id,final_price,nomination_order)
      SELECT '${drafts.nomination}','${drafts.auction}',id,'${context.team}','sold','${context.team}',5,1 FROM public.players ORDER BY id LIMIT 1;
    COMMIT;`)
  seededDrafts = true
  assert.equal((await fetch(`${base}/public/v1/league`)).status, 401)
  assert.equal((await call('league', { method: 'POST' })).status, 405)
  assert.equal((await call('league', {}, '?leagueId=other')).status, 400)
  const ids = JSON.parse(sql('SELECT json_agg(DISTINCT user_id) FROM public.league_members'))
  for (const name of ['league','standings','rosters','matchups','scores','schedule','transactions','draft-results','player-stats','projections']) {
    const query = name === 'rosters' ? `?team=${context.team}` : ''
    const response = await call(name, {}, query)
    assert.equal(response.status, 200, `${name} status`)
    const body = await response.json()
    assert.equal(body.$schema, `urn:pancake:public:v1:${name}`)
    const text = JSON.stringify(body)
    assert.doesNotMatch(text, /"(?:userId|user_id|email|claims|assignments|activeBids|faabBalance|pendingClaimIds|privateNotes)"/)
    assert.ok(ids.every(id => !text.includes(id)), 'An account identifier leaked')
    counts[name] = body.items.length
    const cliArgs = ['packages/pancake-cli/bin/pancake.mjs', name, '--json', '--no-cache', ...(name === 'rosters' ? ['--team', context.team] : [])]
    const cli = JSON.parse(execFileSync(process.execPath, cliArgs, { encoding: 'utf8', env: { ...process.env, PANCAKE_API_URL: base, PANCAKE_TOKEN: token } }))
    assert.deepEqual(cli, body, `${name} CLI parity`)
  }
  assert.ok(counts.league === 1 && counts.standings > 0 && counts.rosters > 0 && counts['player-stats'] > 0)
  assert.ok(counts['draft-results'] >= 2)
  const known = JSON.parse(sql('SELECT json_build_object(\'player\',player_id,\'year\',season_year) FROM analytics.player_season_totals ORDER BY games_played DESC LIMIT 1'))
  assert.ok(known, 'Restore cached player totals before this check')
  const historical = await (await call('player-stats', {}, `?player=${known.player}&season=${known.year}`)).json()
  assert.equal(historical.items.length, 1)
  assert.ok(historical.items[0].points > 0)
  const week = Number(sql(`SELECT min(week_number) FROM public.matchups WHERE league_id='${context.league}' AND NOT is_voided`))
  const scores = await (await call('scores', {}, `?week=${week}`)).json()
  assert.ok(scores.items.length > 0)
  assert.ok(scores.items.every(item => item.weekNumber <= week && item.endWeekNumber >= week))
  const response = await call('standings')
  const cached = await call('standings', { headers: { 'If-None-Match': response.headers.get('etag') } })
  assert.equal(cached.status, 304)
  assert.equal(await cached.text(), '')
  const first = await (await call('standings', {}, '?limit=1')).json()
  assert.ok(first.nextCursor)
  const second = await (await call('standings', {}, `?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json()
  assert.notEqual(first.items[0].teamId, second.items[0].teamId)
  sql(`UPDATE public.league_share_tokens SET window_reads=60,window_started_at=date_trunc('minute',now()) WHERE league_id='${context.league}'`)
  assert.equal((await call('league')).status, 429)
  sql(`BEGIN; SELECT set_config('request.jwt.claim.sub','${context.owner}',true); SELECT public.public_share_token('${context.league}','revoke'); COMMIT;`)
  assert.equal((await call('standings', { headers: { 'If-None-Match': response.headers.get('etag') } })).status, 401)
  console.log(JSON.stringify({ database: 'pass', http: 'pass', cli: 'pass', privateFields: 'absent', etag: 304, rateLimit: 429, revoked: 401, counts }))
} finally {
  if (seededDrafts) sql(`BEGIN; SET LOCAL session_replication_role=replica;
    DELETE FROM public.snake_draft_picks WHERE draft_id='${drafts.snake}';
    DELETE FROM public.nominations WHERE draft_id='${drafts.auction}';
    DELETE FROM public.drafts WHERE id IN ('${drafts.snake}','${drafts.auction}'); COMMIT;`)
  sql(`BEGIN; SELECT set_config('request.jwt.claim.sub','${context.owner}',true); SELECT public.public_share_token('${context.league}','revoke'); COMMIT;`)
}

}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.stderr ? String(error.stderr).split('\n')[0] : error.message)
    process.exitCode = 1
  })
}
