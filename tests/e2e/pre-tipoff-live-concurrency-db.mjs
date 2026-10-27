import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
const db = process.env.SUPABASE_DB_URL
assert(db && new URL(db).hostname === '127.0.0.1')
const prefix = 'owned-tipoff-live-' + randomUUID()
const quote = value => "'" + String(value).replaceAll("'", "''") + "'"
const parse = value => JSON.parse(value)
class Session {
  constructor(name) {
    this.pending = null; this.buffer = ''; this.lines = []; this.stderr = ''; this.ended = false
    this.child = spawn('psql', [db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
      env: { ...process.env, PGAPPNAME: `${prefix}-${name}`,
        PGOPTIONS: '-c statement_timeout=20000 -c lock_timeout=18000 -c idle_in_transaction_session_timeout=30000' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk
      let at
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at).replace(/\r$/, ''); this.buffer = this.buffer.slice(at + 1)
        if (this.pending && line === this.pending.marker) {
          const pending = this.pending; this.pending = null; clearTimeout(pending.timer)
          const output = this.lines.join('\n').trim(); this.lines = []; pending.resolve(output)
        } else this.lines.push(line)
      }
    })
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk })
    this.closed = new Promise((resolve) => {
      const end = (code, error) => {
        this.ended = true
        if (this.pending) {
          clearTimeout(this.pending.timer)
          this.pending.reject(error ?? new Error(`Own SQL connection closes (${code}): ${this.stderr}`)); this.pending = null
        }
        resolve(code)
      }
      this.child.on('error', (error) => end(-1, error)); this.child.on('close', (code) => end(code))
    })
  }
  query(statement) {
    assert.equal(this.pending, null); assert.equal(this.ended, false)
    return new Promise((resolve, reject) => {
      const marker = `DONE_${randomUUID()}`
      const timer = setTimeout(() => { this.child.kill('SIGTERM'); reject(new Error('Own SQL query exceeds 25 seconds')) }, 25000)
      this.pending = { marker, resolve, reject, timer }
      this.child.stdin.write(`${statement}\nSELECT ${quote(marker)};\n`)
    })
  }
  close() {
    if (!this.closePromise) this.closePromise = (async () => {
      if (this.pending) this.child.kill('SIGTERM')
      else if (!this.ended) await this.query('ROLLBACK;').catch(() => {})
      this.child.stdin.end(); await this.closed
    })()
    return this.closePromise
  }
}

const control = new Session('control')
const live = new Session('live')
const lineup = new Session('lineup')
const ids = Object.fromEntries(['user','league','season','member','player','game','token'].map(key => [key,randomUUID()]))
const tag = ids.league.replaceAll('-', '')
const trigger = 'tipoff_live_' + tag
const barrier = Math.floor(Math.random() * 1000000000)
const provider = '002-overlap-' + ids.game
let tipoff
let year
const stats = [{ player_id: ids.player, game_id: ids.game, points: 10, rebounds: 2, assists: 3, did_not_play: false }]
const assignments = [{ player_id: ids.player, slot_type: 'PG', week_number: 1, is_auto_set: true }]
const save = (elapsed = 300, data = stats) => `SELECT public.save_live_game_stats_atomic(${quote(ids.game)},${quote(provider)},${quote(JSON.stringify(data))}::jsonb,${elapsed});`
const apply = () => `SELECT public.apply_pre_tipoff_lineup(${quote(tipoff)},${quote(ids.token)},${quote(ids.league)},${quote(ids.season)},${quote(ids.member)},${quote(JSON.stringify(assignments))}::jsonb);`
const snapshot = () => control.query(`SELECT jsonb_build_object(
  'stats',(SELECT count(*) FROM public.player_game_stats WHERE game_id=${quote(ids.game)}),
  'points',(SELECT points FROM public.player_game_stats WHERE game_id=${quote(ids.game)}),
  'elapsed',(SELECT live_stats_elapsed_seconds FROM public.nba_games WHERE id=${quote(ids.game)}),
  'totals',(SELECT count(*) FROM analytics.player_season_totals WHERE player_id=${quote(ids.player)}),
  'lineups',(SELECT count(*) FROM public.weekly_lineups WHERE member_id=${quote(ids.member)}),
  'receipts',(SELECT count(*) FROM public.lineup_tipoff_members WHERE member_id=${quote(ids.member)}),
  'optimized',(SELECT last_optimized_at IS NOT NULL FROM public.lineup_optimizer_settings WHERE member_id=${quote(ids.member)}));`).then(parse)
async function waitFor(waiter, blocker, event) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const state = parse(await control.query(`SELECT jsonb_build_object('event',wait_event,'type',wait_event_type,'blockers',pg_blocking_pids(pid)) FROM pg_stat_activity WHERE pid=${waiter};`))
    if (state.type === 'Lock' && state.blockers.includes(blocker) && (!event || state.event === event)) return state
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Expected lock wait ${waiter} on ${blocker} did not occur: live=${live.stderr}; lineup=${lineup.stderr}; pending=${Boolean(lineup.pending)}`)
}
async function assertLeagueLock() {
  assert.equal(await control.query(`DO $$ BEGIN
    BEGIN
      PERFORM 1 FROM public.leagues WHERE id=${quote(ids.league)} FOR NO KEY UPDATE NOWAIT;
      RAISE EXCEPTION 'Concurrent league settings writer is not blocked';
    EXCEPTION WHEN lock_not_available THEN NULL; END;
  END $$; SELECT 'settings-protected';`), 'settings-protected')
}
try {
  year = Number(await control.query('SELECT COALESCE(max(season_year),9399)+1 FROM public.season_weeks;'))
  assert(year < 9999)
  const fixture = parse(await control.query(`BEGIN;
    INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(${quote(ids.user)},${quote(ids.user+'@example.invalid')},jsonb_build_object('username',${quote('Overlap'+tag)}));
    INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size,auction_budget,scoring_settings)
      VALUES(${quote(ids.league)},'Synthetic overlap',${quote(ids.league)},${quote(ids.user)},'active',12,200,'{"points":1,"rebounds":2,"assists":3}');
    INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
      VALUES(${quote(ids.member)},${quote(ids.league)},${quote(ids.user)},'commissioner','Synthetic lineup');
    INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(${quote(ids.season)},${quote(ids.league)},${year},true);
    INSERT INTO public.lineup_optimizer_settings(league_id,league_season_id,member_id,enabled)
      VALUES(${quote(ids.league)},${quote(ids.season)},${quote(ids.member)},true) ON CONFLICT (league_id,league_season_id,member_id) DO UPDATE SET league_season_id=EXCLUDED.league_season_id,enabled=true;
    INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
      VALUES(${year},1,(now() AT TIME ZONE 'America/New_York')::date,(now() AT TIME ZONE 'America/New_York')::date+6);
    INSERT INTO public.players(id,first_name,last_name,nba_team,position,eligible_positions,career_games_base,career_games_base_season,career_games_base_source,career_games_base_checked_at)
      VALUES(${quote(ids.player)},'Synthetic',${quote(tag)},'ZX1','PG',ARRAY['PG'],0,${year},'rookie',now());
    INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      VALUES(${quote(ids.league)},${quote(ids.season)},${quote(ids.member)},${quote(ids.player)},'draft');
    DELETE FROM public.lineup_slot_templates WHERE league_id=${quote(ids.league)};
    INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) VALUES(${quote(ids.league)},'PG',1);
    INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
      VALUES(${quote(ids.game)},${quote(provider)},${year},1,(now() AT TIME ZONE 'America/New_York')::date,'ZX1','ZX2','Scheduled',clock_timestamp()+interval '90 seconds');
    INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,game_date,status,token,lease_until,input_revision)
      SELECT game_time,game_date,'running',${quote(ids.token)},clock_timestamp()+interval '5 minutes',1 FROM public.nba_games WHERE id=${quote(ids.game)};
    CREATE FUNCTION private.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.league_id=${quote(ids.league)}::uuid THEN PERFORM pg_advisory_xact_lock(919573,${barrier}); END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER ${trigger} BEFORE INSERT ON private.player_stats_hint_pending FOR EACH ROW EXECUTE FUNCTION private.${trigger}();
    COMMIT;
    SELECT jsonb_build_object('tipoff',game_time) FROM public.nba_games WHERE id=${quote(ids.game)};`))
  tipoff = fixture.tipoff
  const before = await snapshot()
  assert.equal(before.stats,0); assert.equal(before.lineups,0); assert.equal(before.receipts,0)
  const controlPid = Number(await control.query('SELECT pg_backend_pid();'))
  const livePid = Number(await live.query('SELECT pg_backend_pid();'))
  const lineupPid = Number(await lineup.query('SELECT pg_backend_pid();'))
  await control.query(`SELECT pg_advisory_lock(919573,${barrier});`)
  await live.query("BEGIN; SET LOCAL deadlock_timeout='100ms'; SET LOCAL ROLE service_role;")
  const livePending = live.query(save()+' COMMIT;').then(output => ({output}), error => ({error}))
  const liveWait = await waitFor(livePid,controlPid,'advisory')
  await lineup.query("BEGIN; SET LOCAL deadlock_timeout='100ms'; SET LOCAL ROLE service_role;")
  const lineupPending = lineup.query(apply()).then(output => ({output}), error => ({error}))
  const lineupWait = await waitFor(lineupPid,livePid,undefined)
  assert.deepEqual(await snapshot(),before,'Neither transaction exposes partial state while blocked')
  await assertLeagueLock()
  await control.query(`SELECT pg_advisory_unlock(919573,${barrier});`)
  const [liveResult,lineupResult] = await Promise.all([livePending,lineupPending])
  if ('error' in liveResult || 'error' in lineupResult) {
    if (!('error' in lineupResult)) await lineup.query('COMMIT;')
    const after = await snapshot()
    if ('error' in liveResult) {
      assert.equal(after.stats,0); assert.equal(after.totals,0); assert.equal(after.elapsed,before.elapsed)
    }
    if ('error' in lineupResult) {
      assert.equal(after.lineups,0); assert.equal(after.receipts,0); assert.equal(after.optimized,false)
    }
    console.log(JSON.stringify({liveWait,lineupWait,rollbackVerified:true,after}))
    const failure = 'error' in liveResult ? liveResult.error : 'error' in lineupResult ? lineupResult.error : new Error('Unexpected concurrent result')
    console.error(failure)
    throw failure
  }
  assert.equal(liveResult.output,'1'); assert.equal(lineupResult.output,'t')
  await control.query(`BEGIN; SELECT 1 FROM public.leagues WHERE id=${quote(ids.league)} FOR KEY SHARE NOWAIT; ROLLBACK;`)
  await assertLeagueLock()
  assert.equal((await snapshot()).lineups,0,'Successful uncommitted lineup remains invisible')
  await lineup.query('COMMIT;')
  const after = await snapshot()
  assert.deepEqual(after,{stats:1,points:10,elapsed:300,totals:1,lineups:1,receipts:1,optimized:true})
  const scored = parse(await control.query(`SELECT jsonb_build_object('points',public.compute_fantasy_points(s.id,wl.league_id),'slot',wl.slot_type,'player',wl.player_id,'totals',t.points,'games',t.games_played)
    FROM public.weekly_lineups wl JOIN public.player_game_stats s ON s.player_id=wl.player_id AND s.game_id=${quote(ids.game)}
    JOIN analytics.player_season_totals t ON t.player_id=s.player_id AND t.season_year=${year}
    WHERE wl.member_id=${quote(ids.member)};`))
  assert.deepEqual(scored,{points:23,slot:'PG',player:ids.player,totals:10,games:1})
  const stored = await control.query(`SELECT to_jsonb(w) FROM public.weekly_lineups w WHERE member_id=${quote(ids.member)};`)
  assert.equal(await lineup.query(apply()),'f')
  assert.equal(await live.query(save()),'0')
  assert.equal(await live.query(save(299,[{...stats[0],points:99}])),'0')
  assert.deepEqual(await snapshot(),after)
  assert.equal(await control.query(`SELECT to_jsonb(w) FROM public.weekly_lineups w WHERE member_id=${quote(ids.member)};`),stored)
  console.log(JSON.stringify({result:'PASS',liveWait,lineupWait,after,scored,settingsProtected:true,keyShareCompatible:true,retriesStable:true}))
} finally {
  if (control.stderr) console.error(control.stderr)
  if (!control.ended) await control.query(`SELECT pg_advisory_unlock(919573,${barrier});`).catch(() => {})
  await Promise.all([live.close(),lineup.close()])
  const cleanup = new Session('cleanup')
  await cleanup.query(`DROP TRIGGER IF EXISTS ${trigger} ON private.player_stats_hint_pending;
    DROP FUNCTION IF EXISTS private.${trigger}();
    DELETE FROM public.lineup_tipoff_members WHERE member_id=${quote(ids.member)};
    DELETE FROM public.lineup_tipoff_dispatches WHERE token=${quote(ids.token)};
    DELETE FROM public.player_game_stats WHERE game_id=${quote(ids.game)};
    DELETE FROM public.nba_games WHERE id=${quote(ids.game)};
    DELETE FROM public.leagues WHERE id=${quote(ids.league)};
    DELETE FROM public.players WHERE id=${quote(ids.player)};
    DELETE FROM auth.users WHERE id=${quote(ids.user)};
    ${year ? `DELETE FROM public.season_weeks WHERE season_year=${year};` : ''}`)
  await Promise.all([cleanup.close(),control.close()])
}
