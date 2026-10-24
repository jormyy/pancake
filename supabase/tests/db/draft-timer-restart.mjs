import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const url = new URL(process.env.SUPABASE_DB_URL)
assert(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === (process.env.PANCAKE_TEST_DB_PORT ?? '54322'))
const sql = statement => execFileSync('psql', [url.toString(), '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8' }).trim()
const user = randomUUID(), league = randomUUID(), season = randomUUID(), member = randomUUID(), draft = randomUUID()
try {
  sql(`BEGIN;
    INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data) VALUES('${user}','authenticated','authenticated','${user}@example.test','{}');
    INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES('${league}','Synthetic restart','${league}','${user}','drafting');
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES('${season}','${league}',2189,true);
    INSERT INTO league_members(id,league_id,user_id,role) VALUES('${member}','${league}','${user}','commissioner');
    INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,pick_timer_seconds) VALUES('${draft}','${league}','${season}','snake','in_progress',true,604800);
    INSERT INTO snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,timer_expires_at) VALUES('${draft}',1,1,1,'${member}',clock_timestamp()+make_interval(secs=>604800));
    COMMIT;`)
  const deadline = sql(`SELECT extract(epoch FROM timer_expires_at) FROM snake_draft_picks WHERE draft_id='${draft}'`)
  for (const zone of ['America/New_York', 'America/Los_Angeles', 'UTC']) {
    const reconnected = sql(`SET TIME ZONE '${zone}'; SELECT extract(epoch FROM timer_expires_at) FROM snake_draft_picks WHERE draft_id='${draft}'`)
    assert.equal(reconnected, deadline)
  }
  sql(`SELECT pause_draft_atomic('${draft}')`)
  assert.equal(sql(`SELECT status||':'||timer_paused_remaining_seconds FROM drafts WHERE id='${draft}'`), 'paused:604800')
  sql(`SELECT resume_draft_atomic('${draft}')`)
  const restored = Number(sql(`SELECT extract(epoch FROM timer_expires_at-clock_timestamp()) FROM snake_draft_picks WHERE draft_id='${draft}'`))
  assert(restored > 604798 && restored <= 604800)
  console.log(JSON.stringify({ provenance: 'SYNTHETIC', case: 'seven-day deadline and pause survive fresh processes and viewer zones', passed: true }))
} finally {
  sql(`DELETE FROM snake_draft_picks WHERE draft_id='${draft}'; DELETE FROM drafts WHERE id='${draft}'; DELETE FROM leagues WHERE id='${league}'; DELETE FROM auth.users WHERE id='${user}';`)
}
