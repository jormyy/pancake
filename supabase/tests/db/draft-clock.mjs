import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const url = process.env.SUPABASE_DB_URL
assert(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname) && new URL(url).port === (process.env.PANCAKE_TEST_DB_PORT ?? '54322'), 'Use an isolated local database')
const prefix = `draft-clock-${process.pid}`
let serial = 0
class Session {
  constructor(name) {
    this.name = name
    this.pending = null
    this.buffer = ''
    this.lines = []
    this.child = spawn('psql', [url, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { env: { ...process.env, PGAPPNAME: name }, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk
      let index
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 1)
        if (this.pending && line === this.pending.marker) {
          const pending = this.pending
          this.pending = null
          pending.resolve(this.lines.join('\n'))
          this.lines = []
        } else this.lines.push(line)
      }
    })
    this.child.stderr.on('data', chunk => process.stderr.write(chunk))
    this.closed = new Promise(resolve => this.child.on('close', code => {
      this.pending?.reject(Error(`SQL session closed with ${code}`))
      this.pending = null
      resolve(code)
    }))
  }
  query(statement) {
    assert.equal(this.pending, null)
    return new Promise((resolve, reject) => {
      const marker = `DONE_${++serial}`
      this.pending = { resolve, reject, marker }
      this.child.stdin.write(`${statement};\n\\echo ${marker}\n`)
    })
  }
  async close() {
    this.child.stdin.end()
    await this.closed
  }
}
const root = new Session(`${prefix}-root`)
const actors = [new Session(`${prefix}-one`), new Session(`${prefix}-two`)]
const users = [randomUUID(), randomUUID()], members = [randomUUID(), randomUUID()]
const league = randomUUID(), season = randomUUID(), nomination = randomUUID()
const auction = randomUUID(), snake = randomUUID(), players = [randomUUID(), randomUUID(), randomUUID()]
const failures = []
let pending
const literal = value => `'${value.replaceAll("'", "''")}'`
const bid = (index, amount) => `SELECT public.place_auction_bid_atomic('${auction}','${members[index]}','${nomination}',${amount},'${users[index]}')`
const pick = (player, member = members[0]) => `SELECT public.make_snake_pick_atomic('${snake}','${member}','${player}')`
const attempt = (actor, command) => actor.query(`BEGIN; SET LOCAL statement_timeout='8s'; SET LOCAL ROLE service_role; SELECT pg_temp.attempt(${literal(command)}); COMMIT;`)
async function delayed(command, table, id, column, expected) {
  await root.query(`UPDATE public.${table} SET ${column}=clock_timestamp()+interval '1 second' WHERE id='${id}'; BEGIN; SELECT id FROM public.${table} WHERE id='${id}' FOR UPDATE;`)
  pending = attempt(actors[0], command)
  let blocked = false
  for (let n = 0; n < 100; n++) {
    const state = await root.query(`SELECT wait_event_type FROM pg_stat_activity WHERE application_name='${actors[0].name}'`)
    if (state === 'Lock') { blocked = true; break }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert(blocked, 'Actor must reach the real held row lock')
  await root.query(`SELECT pg_sleep(greatest(extract(epoch FROM ${column}-clock_timestamp()),0)::double precision+0.05) FROM public.${table} WHERE id='${id}'; COMMIT;`)
  const result = await pending
  pending = null
  console.log(JSON.stringify({ case: expected, result, realLock: true }))
  if (!result.includes(expected)) failures.push(`${expected}: ${result}`)
}
try {
  await root.query(`BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data) SELECT id,'authenticated','authenticated',id||'@example.test','{}' FROM unnest(ARRAY['${users[0]}'::uuid,'${users[1]}'::uuid])id;
INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size) VALUES('${league}','Draft clock','${league}','${users[0]}','drafting',5);
INSERT INTO public.league_members(id,league_id,user_id,role) VALUES('${members[0]}','${league}','${users[0]}','commissioner'),('${members[1]}','${league}','${users[1]}','manager');
INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES('${season}','${league}',2189,true);
INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number) SELECT id,'Clock',id::text,'PG',ARRAY['PG'],0,1 FROM unnest(ARRAY[${players.map(id => `'${id}'::uuid`).join(',')}])id;
INSERT INTO public.drafts(id,league_id,league_season_id,draft_type,status,budget_per_team,pick_timer_seconds,rounds,is_mock,timer_expiry_behavior)
VALUES('${auction}','${league}','${season}','auction','in_progress',100,30,NULL,true,'auto_pick'),('${snake}','${league}','${season}','snake','in_progress',NULL,60,1,true,'skip_pick');
INSERT INTO public.draft_orders(draft_id,member_id,position) SELECT d,m,ord::int FROM unnest(ARRAY['${auction}'::uuid,'${snake}'::uuid])d CROSS JOIN unnest(ARRAY['${members[0]}'::uuid,'${members[1]}'::uuid]) WITH ORDINALITY AS u(m,ord);
INSERT INTO public.draft_budgets(draft_id,member_id,initial_budget,remaining) SELECT '${auction}',id,100,100 FROM unnest(ARRAY['${members[0]}'::uuid,'${members[1]}'::uuid])id;
INSERT INTO public.nominations(id,draft_id,nominating_member_id,player_id,nomination_order,status,current_bid_amount,countdown_expires_at) VALUES('${nomination}','${auction}','${members[0]}','${players[0]}',1,'open',0,clock_timestamp()+interval '30 seconds');
INSERT INTO public.snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,timer_expires_at) VALUES('${snake}',1,1,1,'${members[0]}',clock_timestamp()+interval '30 seconds'),('${snake}',2,1,2,'${members[1]}',NULL);
COMMIT;`)
  for (const actor of actors) await actor.query(`CREATE FUNCTION pg_temp.attempt(command text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN EXECUTE command; RETURN 'accepted'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE||':'||SQLERRM; END $$;`)
  await delayed(bid(0, 1), 'nominations', nomination, 'countdown_expires_at', 'Bidding has expired')
  const firstPick = await root.query(`SELECT id FROM public.snake_draft_picks WHERE draft_id='${snake}' AND overall_pick=1`)
  await delayed(pick(players[1]), 'snake_draft_picks', firstPick, 'timer_expires_at', 'Pick timer has expired')
  if (failures.length === 0) {
    await root.query(`UPDATE public.nominations SET countdown_expires_at=clock_timestamp()+interval '10 seconds' WHERE id='${nomination}'; UPDATE public.snake_draft_picks SET timer_expires_at=clock_timestamp()+interval '10 seconds' WHERE id='${firstPick}';`)
    const bids = await Promise.all(actors.map((actor, index) => attempt(actor, bid(index, 2))))
    assert.equal(bids.filter(result => result === 'accepted').length, 1)
    const picks = await Promise.all(actors.map((actor, index) => attempt(actor, pick(players[index + 1]))))
    assert.equal(picks.filter(result => result === 'accepted').length, 1)
    assert.equal(await root.query(`SELECT count(*) FROM public.snake_draft_picks WHERE draft_id='${snake}' AND player_id IS NOT NULL`), '1')
    await root.query(`UPDATE public.nominations SET countdown_expires_at=clock_timestamp()-interval '1 second' WHERE id='${nomination}'`)
    const closings = await Promise.all(actors.map(actor => actor.query(`SELECT public.close_auction_nomination_atomic('${nomination}')`)))
    assert.equal(closings.filter(result => result === 't').length, 1)
    console.log(JSON.stringify({ bids, picks, closings, exactlyOneWinner: true }))
  }
} finally {
  await root.query('ROLLBACK;').catch(() => {})
  await pending?.catch(() => {})
  for (const actor of actors) await actor.close()
  await root.query(`DELETE FROM public.drafts WHERE id IN('${auction}','${snake}'); DELETE FROM public.leagues WHERE id='${league}'; DELETE FROM public.players WHERE id IN(${players.map(literal).join(',')}); DELETE FROM auth.users WHERE id IN(${users.map(literal).join(',')});`)
  await root.close()
  console.log('Owned draft clock fixtures and sessions removed')
}
assert.deepEqual(failures, [], 'Lock waits must not extend server deadlines')
