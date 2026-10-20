import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const task = path.join(homedir(), 'pancake-t_4ba51e0d')
const lane = path.join(task, 'lanes/post')
assert.equal(process.cwd(), path.join(lane, 'repo'))
const evidence = path.join(lane, 'evidence/review6')
mkdirSync(evidence, { recursive: true })
const status = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const keys = Object.fromEntries(status.trim().split('\n').map(line => {
  const at = line.indexOf('=')
  return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, '')]
}))
for (const [target, port] of [[keys.API_URL, '57421'], [keys.DB_URL, '57422']]) {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(target).hostname))
  assert.equal(new URL(target).port, port)
}
const env = {
  ...process.env,
  SUPABASE_URL: keys.API_URL,
  E2E_SUPABASE_URL: keys.API_URL,
  SUPABASE_DB_URL: keys.DB_URL,
  E2E_PANCAKE_SUPABASE_SECRET_KEY: keys.SECRET_KEY ?? keys.SERVICE_ROLE_KEY,
  PANCAKE_SUPABASE_SECRET_KEY: keys.SECRET_KEY ?? keys.SERVICE_ROLE_KEY,
  E2E_SUPABASE_PUBLISHABLE_KEY: keys.PUBLISHABLE_KEY ?? keys.ANON_KEY,
  PANCAKE_EDGE_INTERNAL_TOKEN: 'local-database-ci-token',
  PANCAKE_TEST_API_PORT: '57421',
  PANCAKE_TEST_DB_PORT: '57422',
  POST_EVIDENCE: path.join(evidence, 'mutation-baseline'),
}
for (const key of ['POST_ROOKIE_CASE', 'POST_SKIP_PHASE', 'POST_STALE_CASE']) delete env[key]
const rows = []
const run = (name, binary, args, expected = 0) => {
  const started = performance.now()
  const result = spawnSync(binary, args, { env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  const log = path.join(evidence, `${name}.log`)
  const command = `${binary} ${args.join(' ')}`
  writeFileSync(log, `${command}\n${result.stdout ?? ''}${result.stderr ?? ''}\nexit=${result.status} signal=${result.signal}\n`)
  const row = { name, command, exit: result.status, seconds: Math.round((performance.now() - started) / 10) / 100, log, expected }
  rows.push(row)
  writeFileSync(path.join(evidence, 'commands.json'), JSON.stringify(rows, null, 2) + '\n')
  console.log(JSON.stringify(row))
  assert.equal(result.status, expected, log)
}
const sql = statement => execFileSync('psql', [keys.DB_URL, '-XqAtv', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', timeout: 30_000 }).trim()
const hash = value => createHash('sha256').update(value).digest('hex')
const definition = () => sql("SELECT pg_get_functiondef('public.invoke_season_boundary_if_due(timestamptz)'::regprocedure)")
const baseline = definition()
const beforeHash = hash(baseline)
run('three-season', 'npm', ['run', 'test:db:three-season'])
const fixture = JSON.parse(sql(`DO $$
DECLARE usr uuid:=gen_random_uuid(); other_usr uuid:=gen_random_uuid(); league uuid; season uuid; home uuid; away uuid; state league_status;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
  VALUES(usr,'authenticated','authenticated',usr||'@example.test','{}','{}'),
    (other_usr,'authenticated','authenticated',other_usr||'@example.test','{}','{}');
  CREATE TEMP TABLE residue_ids(user_id uuid,league_id uuid);
  INSERT INTO residue_ids(user_id) VALUES(usr),(other_usr);
  FOREACH state IN ARRAY ARRAY['active','playoffs','offseason','setup','drafting']::league_status[] LOOP
    league:=gen_random_uuid(); season:=gen_random_uuid(); home:=gen_random_uuid(); away:=gen_random_uuid();
    INSERT INTO leagues(id,name,slug,commissioner_id,status)
    VALUES(league,'Synthetic chain residue',league::text,usr,state);
    INSERT INTO residue_ids(league_id) VALUES(league);
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,9790,true);
    INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(home,league,usr,'commissioner','Home'),(away,league,other_usr,'manager','Away');
    IF state='active' THEN
      INSERT INTO trades(league_id,league_season_id,proposer_member_id,recipient_member_id,expires_at)
      VALUES(league,season,home,away,now()-interval '1 hour');
    END IF;
  END LOOP;
END; $$;
SELECT jsonb_build_object('users',(SELECT jsonb_agg(user_id) FROM residue_ids WHERE user_id IS NOT NULL),
  'leagues',(SELECT jsonb_agg(league_id) FROM residue_ids WHERE league_id IS NOT NULL));`))
const quote = value => `'${value.replaceAll("'", "''")}'`
const leagueList = fixture.leagues.map(quote).join(',')
const userList = fixture.users.map(quote).join(',')
const snapshot = () => sql(`SELECT jsonb_build_object(
  'leagues',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM leagues l WHERE id IN(${leagueList})),
  'seasons',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM league_seasons s WHERE league_id IN(${leagueList})),
  'trades',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM trades t WHERE league_id IN(${leagueList})));`)
let originalResidue
try {
  originalResidue = snapshot()
  writeFileSync(path.join(evidence, 'residue-before.json'), originalResidue + '\n')
  run('old-gate-residue-red', 'psql', [keys.DB_URL, '-Xv', 'ON_ERROR_STOP=1', '-f', path.join(evidence, 'rookie-drafting-gate-before.sql')], 3)
  assert.match(readFileSync(path.join(evidence, 'old-gate-residue-red.log'), 'utf8'), /requires an isolated empty stack/)
  run('old-deadline-residue-red', 'psql', [keys.DB_URL, '-Xv', 'ON_ERROR_STOP=1', '-f', path.join(evidence, 'deadline-locks-before.sql')], 3)
  assert.match(readFileSync(path.join(evidence, 'old-deadline-residue-red.log'), 'utf8'), /FAIL: expiry resolves due offers/)
  const registrations = JSON.parse(readFileSync('scripts/mutation/post/registrations.json', 'utf8'))
  for (let pass = 1; pass <= 2; pass++) {
    for (const name of Object.keys(registrations['test:db chain'])) run(`pass${pass}-${name.replaceAll(':', '-')}`, 'npm', ['run', name])
    assert.equal(snapshot(), originalResidue, `Pass ${pass} changes committed residue`)
  }
  const oldGate = readFileSync(path.join(task, 'base/supabase/sql/functions/by-name/public/invoke_season_boundary_if_due.sql'), 'utf8')
  assert.ok(!oldGate.includes("'drafting'::public.league_status"))
  try {
    sql(oldGate)
    run('gate-prefix-red', 'node', ['scripts/mutation/post/check.mjs', 'tests/db/rookie-drafting-gate.sql'], 3)
    assert.match(readFileSync(path.join(evidence, 'gate-prefix-red.log'), 'utf8'), /Drafting-only fleet must dispatch at 09:00 ET, got 0/)
  } finally {
    sql(baseline)
    assert.equal(hash(definition()), beforeHash)
    writeFileSync(path.join(evidence, 'gate-restore.json'), JSON.stringify({ before: beforeHash, restored: hash(definition()) }, null, 2) + '\n')
  }
  run('gate-fixed-green', 'node', ['scripts/mutation/post/check.mjs', 'tests/db/rookie-drafting-gate.sql'])
  run('mutation-baseline', 'node', ['scripts/mutation/post/run.mjs', '--baseline', 'rookie-draft-13', 'rookie-draft-17'])
  run('checker-baseline', 'node', ['scripts/mutation/post/check.mjs', 'supabase/tests/db/rookie-backstop.ts'])
  assert.equal(snapshot(), originalResidue)
  writeFileSync(path.join(evidence, 'residue-after.json'), snapshot() + '\n')
} finally {
  assert.equal(hash(definition()), beforeHash)
  sql(`DELETE FROM leagues WHERE id IN(${leagueList}); DELETE FROM profiles WHERE id IN(${userList}); DELETE FROM auth.users WHERE id IN(${userList});`)
}
console.log('SYNTHETIC residue survives two chain passes; the final gate rejects its pre-fix function and passes after restoration.')
