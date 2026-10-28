import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const quote = (value: unknown) => "'" + String(value).replaceAll("'", "''") + "'"

Deno.test({
  name: 'live scoring and injuries finish twenty ordered overlaps without lock waits',
  ignore: Deno.env.get('PANCAKE_LIVE_LOCK_DB_TESTS') !== '1',
  async fn() {
    const db = 'postgresql://postgres:postgres@127.0.0.1:58922/postgres'
    const sql = async (statement: string) => {
      const result = await new Deno.Command('psql', {
        args: [db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', statement],
        stdout: 'piped', stderr: 'piped',
      }).output()
      assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
      return new TextDecoder().decode(result.stdout).trim()
    }
    const status = await new Deno.Command('supabase', { args: ['status', '-o', 'json'], stdout: 'piped', stderr: 'piped' }).output()
    assert.equal(status.code, 0)
    const local = JSON.parse(new TextDecoder().decode(status.stdout))
    assert.equal(local.API_URL, 'http://127.0.0.1:58921')
    Deno.env.set('SUPABASE_URL', local.API_URL)
    Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', local.SECRET_KEY ?? local.SERVICE_ROLE_KEY)
    Deno.env.set('ESPN_SITE_BASE_URL', 'http://injury.invalid')
    Deno.env.set('NBA_CDN_BASE_URL', 'http://nba.invalid')
    const { syncInjuries } = await import('../sync-players/injuries.ts')
    const { ingestTick } = await import('./runner.ts')
    const tag = crypto.randomUUID().replaceAll('-', '')
    const players = [crypto.randomUUID(), crypto.randomUUID()].sort()
    const game = crypto.randomUUID()
    const league = crypto.randomUUID()
    const season = crypto.randomUUID()
    const matchup = crypto.randomUUID()
    const users = [crypto.randomUUID(), crypto.randomUUID()]
    const members = [crypto.randomUUID(), crypto.randomUUID()]
    const provider = '002-lock-' + tag
    const trigger = 'lock_probe_' + tag
    const barrier = Math.floor(Math.random() * 1_000_000_000)
    const nativeFetch = globalThis.fetch
    const timeouts: string[] = []
    let round = 0
    let holder = ''
    let year = 0
    const strict = Deno.env.get('PANCAKE_LIVE_LOCK_STRICT') === '1'
    let lockOutput = ''
    const gate = spawn('psql', [db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] })
    gate.stdout.on('data', chunk => { lockOutput += chunk })
    const gateClosed = new Promise(resolve => gate.on('close', resolve))
    const waitFor = async (ready: () => Promise<boolean> | boolean) => {
      const deadline = performance.now() + 5000
      while (!await ready()) {
        assert.ok(performance.now() < deadline, 'Ordering barrier did not arrive')
        await new Promise(resolve => setTimeout(resolve, 2))
      }
    }
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.hostname === 'injury.invalid') return Response.json({ injuries: [{ id: '2', injuries: players.map((id, index) => ({
        status: round % 2 ? 'Out' : 'Day-To-Day', athlete: { id: String(88000000 + index), displayName: 'Lock ' + id, position: { abbreviation: 'PG' } },
      })) }] })
      if (url.hostname === 'nba.invalid') {
        const board = { gameId: provider, gameStatus: 2, gameStatusText: 'Q1', period: 1, gameClock: 'PT06M00.00S',
          homeTeam: { teamTricode: 'BOS', score: 11 + round }, awayTeam: { teamTricode: 'NYK', score: 10 } }
        if (url.pathname.includes('scoreboard')) return Response.json({ scoreboard: { games: [board] } })
        return Response.json({ game: { ...board, homeTeam: { ...board.homeTeam, players: players.map((id, index) => ({
          personId: 99000000 + index, name: 'Lock ' + id, played: '1', statistics: { minutes: 'PT06M00.00S', points: 10 + round },
        })) }, awayTeam: { ...board.awayTeam, players: [] } } })
      }
      assert.equal(url.origin, local.API_URL, 'Only the private database receives network requests')
      const response = await nativeFetch(request)
      if (!response.ok) {
        const body = await response.clone().text()
        if (body.includes('lock timeout')) timeouts.push(url.pathname + ': ' + body)
      }
      return response
    }
    try {
      year = Number(await sql('SELECT coalesce(max(season_year),2026)+1 FROM public.season_weeks'))
      await sql(`BEGIN;
        INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
          VALUES(${year},1,current_date,current_date+6);
        INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ${users.map((id, index) =>
          `(${quote(id)},${quote(id + '@example.invalid')},jsonb_build_object('username',${quote(tag + index)}))`).join(',')};
        INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size,auction_budget,scoring_settings)
          VALUES(${quote(league)},'Lock fixture',${quote(league)},${quote(users[0])},'active',12,200,'{"points":1}');
        INSERT INTO public.league_members(id,league_id,user_id,role,team_name) VALUES ${members.map((id, index) =>
          `(${quote(id)},${quote(league)},${quote(users[index])},${quote(index ? 'manager' : 'commissioner')},${quote('Lock ' + index)})`).join(',')};
        INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(${quote(season)},${quote(league)},${year},true);
        INSERT INTO public.players(id,first_name,last_name,nba_team,nba_id,espn_id,position,eligible_positions,career_games_base,career_games_base_season,career_games_base_source,career_games_base_checked_at)
          VALUES ${players.map((id, index) => `(${quote(id)},'Lock',${quote(id)},'BOS',${quote(99000000 + index)},${quote(88000000 + index)},NULL,'{}',0,${year - 1},'rookie',now())`).join(',')};
        INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at) VALUES ${players.map((id, index) =>
          `(${quote(league)},${quote(season)},${quote(members[index])},${quote(id)},'draft',now()-interval '1 hour')`).join(',')};
        INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,home_score,away_score,game_status_text,game_time)
          VALUES(${quote(game)},${quote(provider)},${year},1,current_date,'BOS','NYK','InProgress',10,10,'Q1',now()-interval '6 minutes');
        INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id,matchup_type,is_finalized)
          VALUES(${quote(matchup)},${quote(league)},${quote(season)},1,${quote(members[0])},${quote(members[1])},'regular_season',false);
        INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type) VALUES ${players.map((id, index) =>
          `(${quote(league)},${quote(season)},${quote(members[index])},${quote(id)},1,current_date,'PG')`).join(',')};
        SELECT public.save_live_game_stats_atomic(${quote(game)},${quote(provider)},${quote(JSON.stringify(players.map(player_id => ({ player_id, game_id: game, points: 10, minutes_played: 6, did_not_play: false }))))}::jsonb,360);
        CREATE FUNCTION private.${trigger}() RETURNS trigger LANGUAGE plpgsql SET lock_timeout='0' AS $$ BEGIN
          IF (NEW.id=${quote(players[0])}::uuid AND NEW.injury_status IS DISTINCT FROM OLD.injury_status)
            OR (NEW.id=${quote(players[1])}::uuid AND OLD.position IS NULL AND NEW.position IS NOT NULL) THEN
            PERFORM pg_advisory_xact_lock(919574,${barrier});
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER ${trigger} AFTER UPDATE ON public.players FOR EACH ROW EXECUTE FUNCTION private.${trigger}();
        CREATE FUNCTION public.${trigger}() RETURNS jsonb LANGUAGE sql SET search_path='' AS $$
          SELECT jsonb_build_object('role',current_user,'lock_timeout',current_setting('lock_timeout'))
        $$;
        COMMIT; NOTIFY pgrst,'reload schema';`)
      const settings = async () => {
        const response = await nativeFetch(local.API_URL + '/rest/v1/rpc/' + trigger, {
          method: 'POST', headers: { apikey: local.SECRET_KEY ?? local.SERVICE_ROLE_KEY,
            authorization: 'Bearer ' + local.SERVICE_ROLE_KEY, 'content-type': 'application/json' }, body: '{}',
        })
        if (response.status === 404) { await response.body?.cancel(); return null }
        assert.equal(response.status, 200)
        return await response.json()
      }
      await waitFor(async () => (await settings()) !== null)
      assert.deepEqual(await settings(), { role: 'service_role', lock_timeout: '250ms' })
      if (strict) {
        await sql("ALTER ROLE service_role SET lock_timeout='5ms'; NOTIFY pgrst,'reload config'")
        await waitFor(async () => (await settings())?.lock_timeout === '5ms')
      }
      holder = await sql('SELECT public.try_live_poll_lease(779001,600)')
      assert.ok(holder)
      for (round = 0; round <= 20; round++) {
        lockOutput = ''
        gate.stdin.write(`SELECT pg_advisory_lock(919574,${barrier}); SELECT 'locked';\n`)
        await waitFor(() => lockOutput.includes('locked'))
        const injuries = syncInjuries()
        await waitFor(async () => Number(await sql(`SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=919574 AND objid=${barrier} AND NOT granted`)) === 1)
        let finished = false
        const live = ingestTick(holder).then(result => ({ result }), error => ({ error })).finally(() => { finished = true })
        const waits: unknown[] = []
        while (!finished) {
          const observed = JSON.parse(await sql(`SELECT coalesce(jsonb_agg(jsonb_build_object(
            'statement',a.query,'lock',l.locktype,'mode',l.mode,'relation',l.relation::regclass::text,
            'blocker',b.query)), '[]'::jsonb)
            FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid AND NOT l.granted
            JOIN pg_stat_activity b ON b.pid=ANY(pg_blocking_pids(a.pid))
            WHERE a.usename='authenticator' AND a.wait_event_type='Lock' AND l.locktype<>'advisory'`))
          waits.push(...observed)
        }
        const outcome = await live
        gate.stdin.write(`SELECT pg_advisory_unlock(919574,${barrier});\n`)
        const injury = await injuries
        if (waits.length) console.log(JSON.stringify({ round, wait: waits[0], samples: waits.length }))
        if ('error' in outcome) throw outcome.error
        const tick = outcome.result
        assert.deepEqual(tick.failures, [])
        assert.equal(tick.lines, players.length)
        assert.equal(tick.tickRetries, 0)
        assert.equal(tick.scoreRetries, 0)
        assert.equal(injury.failure, null)
        assert.equal(injury.updated, players.length)
        assert.deepEqual(timeouts, [])
        assert.deepEqual(waits, [], 'Live writes must finish while the injury row remains locked')
        const counts = JSON.parse(await sql(`SELECT jsonb_build_object(
          'stats',count(*),'players',count(DISTINCT s.player_id),'points',sum(s.points),
          'injuries',count(*) FILTER(WHERE p.injury_status=${quote(round % 2 ? 'Out' : 'DTD')}),
          'careers',count(*) FILTER(WHERE p.career_regular_season_games=1))
          FROM public.player_game_stats s JOIN public.players p ON p.id=s.player_id WHERE s.game_id=${quote(game)}`))
        assert.deepEqual(counts, { stats: 2, players: 2, points: 2 * (10 + round), injuries: 2, careers: 2 })
        const score = JSON.parse(await sql(`SELECT jsonb_build_object('home',home_points,'away',away_points)
          FROM public.matchups WHERE id=${quote(matchup)}`))
        assert.deepEqual(score, { home: 10 + round, away: 10 + round })
      }
      console.log(`21 overlaps: 42 stat lines, 42 injury updates and 21 matchup publications; zero lock waits or timeouts at ${strict ? 5 : 250}ms`)
    } finally {
      globalThis.fetch = nativeFetch
      gate.stdin.end()
      await gateClosed
      await sql(`${strict ? "ALTER ROLE service_role SET lock_timeout='250ms'; NOTIFY pgrst,'reload config';" : ''}
        DROP TRIGGER IF EXISTS ${trigger} ON public.players; DROP FUNCTION IF EXISTS private.${trigger}();
        DROP FUNCTION IF EXISTS public.${trigger}();
        ${holder ? `SELECT public.release_live_poll_lease(779001,${quote(holder)});` : ''}
        DELETE FROM public.leagues WHERE id=${quote(league)};
        DELETE FROM auth.users WHERE id IN (${users.map(quote).join(',')});
        DELETE FROM public.player_game_stats WHERE game_id=${quote(game)};
        DELETE FROM public.nba_games WHERE id=${quote(game)};
        DELETE FROM public.players WHERE id IN (${players.map(quote).join(',')});
        ${year ? `DELETE FROM public.season_weeks WHERE season_year=${year};` : ''}`)
    }
  },
})
