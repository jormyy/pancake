import assert from 'node:assert/strict'
import { buildScheduleSyncPlan, buildSeasonWeekRows } from '../../functions/_shared/schedule.ts'

const api = Deno.env.get('SUPABASE_URL')!, db = Deno.env.get('SUPABASE_DB_URL')!
for (const [url, port] of [[api, Deno.env.get('PANCAKE_TEST_API_PORT') ?? '54321'], [db, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322']]) {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
  assert.equal(new URL(url).port, port)
}
const q = (value: string) => `'${value.replaceAll("'", "''")}'`
async function sql(statement: string) {
  const child = new Deno.Command('psql', { args: [db, '-XqAtv', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn()
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(statement)); await writer.close()
  const output = await child.output()
  assert.equal(output.code, 0, new TextDecoder().decode(output.stderr))
  return new TextDecoder().decode(output.stdout).trim()
}
const pushes: { to: string; data: { notificationEvent: string; leagueSeasonId: string } }[] = []
const issuedTickets: string[] = [], receivedTickets: string[] = []
let receiptRequests = 0, worker: Deno.HttpServer<Deno.NetAddr> | undefined
const fake = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
  const body = await request.json()
  if (new URL(request.url).pathname === '/receipts') {
    receiptRequests++
    receivedTickets.push(...body.ids)
    return Response.json({ data: Object.fromEntries(body.ids.map((id: string) => [id, { status: 'ok' }])) })
  }
  pushes.push(...body)
  return Response.json({ data: body.map(() => { const id=crypto.randomUUID(); issuedTickets.push(id); return { status: 'ok', id } }) })
})
Deno.env.set('EXPO_PUSH_URL', `http://127.0.0.1:${fake.addr.port}/send`)
Deno.env.set('EXPO_RECEIPTS_URL', `http://127.0.0.1:${fake.addr.port}/receipts`)
Deno.env.set('EXPO_RECEIPT_DELAY_SECONDS', '0')
const nativeFetch = globalThis.fetch
let scoreWrites = 0
const finalizedWeeks = new Set<number>()
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  assert.ok([new URL(api).origin, `http://127.0.0.1:${fake.addr.port}`, worker ? `http://127.0.0.1:${worker.addr.port}` : ''].includes(url.origin), 'Only guarded local services receive requests')
  if (url.pathname.endsWith('/finalize_score_week_atomic')) {
    scoreWrites++
    finalizedWeeks.add(JSON.parse(String(init?.body)).p_week_number)
  }
  return nativeFetch(input, init)
}
const { syncScores } = await import('../../functions/_shared/syncScores.ts')
const { generateMatchups } = await import('../../functions/_shared/matchupGeneration.ts')
assert.equal(await sql("SELECT category||':'||default_enabled::text FROM notif_event_catalog WHERE event_type='playoff_clinched'"),'playoff:false')
const originalWeeks = await sql("SELECT COALESCE(jsonb_agg(to_jsonb(w)),'[]') FROM season_weeks w WHERE season_year IN(2025,2026)")
const failures: string[] = []
try {
  for (const year of [2025, 2026]) {
    const raw = await Deno.readTextFile(new URL(`../../../tests/fixtures/calendar/espn-${year-1}-${year}.json`, import.meta.url))
    const fixture = JSON.parse(raw)
    const weeks = buildSeasonWeekRows(buildScheduleSyncPlan(fixture.games, new Date(`${year-1}-10-01T00:00:00Z`)).rows, year)
    assert.equal(weeks.length, 24)
    assert.equal((Date.parse(weeks[16].week_end)-Date.parse(weeks[16].week_start))/86400000, 13)
    await sql(`INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
      SELECT season_year,week_number,week_start,week_end FROM jsonb_to_recordset(${q(JSON.stringify(weeks))}) w(season_year int,week_number int,week_start date,week_end date)
      ON CONFLICT(season_year,week_number) DO UPDATE SET week_start=EXCLUDED.week_start,week_end=EXCLUDED.week_end`)
    console.log(JSON.stringify({ provenance: 'REAL-DERIVED calendar; SYNTHETIC leagues and score inputs', year, mergedWeek: weeks[16], fixtureSha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), value => value.toString(16).padStart(2,'0')).join('') }))
    for (const skipped of [false, true]) for (const mode of ['early', 'tie', 'odd', 'all', 'two']) {
      const selected = Deno.env.get('POST_CLINCH_CASE')
      if (selected && selected !== `${year}:${skipped}:${mode}`) continue
      const count = ['odd','all'].includes(mode) ? 5 : mode === 'two' ? 2 : 4
      const entrants = mode === 'all' ? count : mode === 'odd' ? 3 : 2
      const league = crypto.randomUUID(), season = crypto.randomUUID(), foreignLeague = crypto.randomUUID()
      const users = Array.from({ length: count+1 }, () => crypto.randomUUID())
      const members = users.map(() => crypto.randomUUID()), players = users.slice(0,count).map(() => crypto.randomUUID())
      const games = Array.from({ length: 19 }, () => crypto.randomUUID())
      try {
        await sql(`BEGIN;
          ${users.map(user => `INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) VALUES(${q(user)},'authenticated','authenticated',${q(user+'@example.test')},'{}','{}');`).join('\n')}
          INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week,playoff_entrants,playoff_round_lengths,scoring_settings)
            VALUES(${q(league)},'Synthetic clinch',${q(league)},${q(users[0])},'setup',20,${entrants},ARRAY[${Array(Math.ceil(Math.log2(entrants))).fill(1).join(',')}],'{"points":1}');
          INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES(${q(foreignLeague)},'Outside clinch league',${q(foreignLeague)},${q(users[count])},'setup');
          INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${q(members[count])},${q(foreignLeague)},${q(users[count])},'commissioner','Outside');
          INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(gen_random_uuid(),${q(foreignLeague)},${q(users[0])},'manager','Same user, other league');
          INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(season)},${q(league)},${year},true);
          ${members.slice(0,count).map((member,i) => `INSERT INTO league_members(id,league_id,user_id,role,team_name,joined_at) VALUES(${q(member)},${q(league)},${q(users[i])},'${i?'manager':'commissioner'}','Team ${i}',now()+interval '${i} seconds');
            INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team) VALUES(${q(players[i])},'Synthetic',${q(players[i])},'PG',ARRAY['PG'],'Active','XCL');
            INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at) VALUES(${q(league)},${q(season)},${q(member)},${q(players[i])},'draft','2024-01-01');`).join('\n')}
          INSERT INTO notification_preferences(user_id,event_settings) SELECT id,(SELECT jsonb_object_agg(event_type,false) FROM notif_event_catalog) FROM unnest(ARRAY[${users.map(q).join(',')}]::uuid[]) id;
          COMMIT;`)
        await generateMatchups(league, season, 19)
        if (skipped) await sql(`BEGIN; SELECT set_config('request.jwt.claim.sub',${q(users[0])},true); SELECT update_league_settings_atomic(${q(league)},'{"skipped_weeks":[1]}'); COMMIT;`)
        await sql(`UPDATE leagues SET status='active' WHERE id=${q(league)};
          UPDATE matchups SET is_voided=true,is_finalized=false WHERE league_season_id=${q(season)} AND week_number=2 AND home_member_id=(SELECT home_member_id FROM matchups WHERE league_season_id=${q(season)} AND week_number=2 ORDER BY id LIMIT 1);`)
        const matches: { week_number: number; home_member_id: string; away_member_id: string }[] = JSON.parse(await sql(`SELECT jsonb_agg(jsonb_build_object('week_number',week_number,'home_member_id',home_member_id,'away_member_id',away_member_id)) FROM matchups WHERE league_season_id=${q(season)} AND NOT is_voided`))
        const points = (week: number, i: number) => {
          if (mode !== 'tie') return 100-i*10
          if (week < 18) return 1
          if (week === 18) return i === 0 ? 2 : 1
          const pairing = matches.find(match => match.week_number === 19 && [match.home_member_id,match.away_member_id].includes(members[i]))!
          if (i === 0) return 0
          if ([pairing.home_member_id,pairing.away_member_id].includes(members[0])) return 500
          return pairing.home_member_id === members[i] ? 501 : 0
        }
        await sql(`BEGIN; ${weeks.slice(0,19).map((week,w) => `INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
          VALUES(${q(games[w])},${q('002-clinch-'+games[w])},${year},${w+1},${q(week.week_start)},${q(week.week_start+'T20:00:00Z')},'XCL','XCM','Final',now());
          ${players.map((player,i) => `INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,game_date,points,did_not_play) VALUES(${q(player)},${q(games[w])},${year},${w+1},${q(week.week_start)},${points(w+1,i)},false);
            INSERT INTO weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type,is_auto_set) VALUES(${q(league)},${q(season)},${q(members[i])},${q(player)},${w+1},${q(week.week_start)},'PG',false);`).join('\n')}`).join('\n')} COMMIT;`)
        const rows = () => sql(`SELECT COALESCE(jsonb_agg(member_id ORDER BY member_id),'[]') FROM notification_outbox WHERE event_type='playoff_clinched' AND data->>'leagueSeasonId'=${q(season)}`)
        const tick = async (week: number) => {
          scoreWrites = 0; finalizedWeeks.clear()
          await syncScores(league, new Date(weeks[week].week_start+'T12:00:00Z'), { recoverStats: false })
          assert.ok(scoreWrites > 0, 'The real scorer must call finalization')
          if (skipped) assert.ok(!finalizedWeeks.has(1), 'The skipped week is never finalized')
        }
        await tick(mode === 'tie' ? 18 : 16)
        let clinched: string[] = JSON.parse(await rows())
        if (mode === 'tie') assert.deepEqual(clinched, [], 'Reachable wins ties with undecided tiebreaks cannot clinch')
        else {
          assert.ok(clinched.includes(members[0]), 'The early certain clincher must have an outbox row')
          if (entrants === count) assert.deepEqual(clinched, members.slice(0,count).sort(), 'All-team brackets qualify everyone, including a bye team')
          assert.ok(clinched.length <= entrants)
        }
        await tick(19)
        const finalSeeds: string[] = JSON.parse(await sql(`SELECT jsonb_agg(member_id ORDER BY seed_rank) FROM private.playoff_seed_rankings(${q(league)},${q(season)},20) WHERE seed_rank<=${entrants}`))
        clinched = JSON.parse(await rows())
        assert.deepEqual(clinched, [...finalSeeds].sort(), 'Final-week clinchers must match all actual ranking tiebreaks')
        if (mode === 'tie') assert.ok(!clinched.includes(members[0]), 'A reachable tiebreak loss must defeat the premature clinch')
        const before = await rows()
        await sql(`UPDATE player_game_stats SET points=points+1 WHERE game_id=${q(games[16])}`)
        await tick(19)
        await sql(`UPDATE player_game_stats SET points=points+1 WHERE game_id=${q(games[16])}`)
        await tick(19)
        assert.equal(await rows(), before, 'Re-finalization and correction replay cannot enqueue twice')
        assert.equal(await sql(`SELECT count(*) FROM notification_outbox WHERE event_type='playoff_clinched' AND member_id IN(SELECT id FROM league_members WHERE league_id=${q(foreignLeague)})`), '0')
        assert.equal(await sql(`SELECT count(*) FROM notification_outbox WHERE event_type='playoff_eliminated' AND member_id IN(${members.map(q).join(',')})`), '0', 'Regular-season qualification is not postseason elimination')
        if (year === 2025 && !skipped && mode === 'all') {
          await sql(`UPDATE profiles SET push_token='ExponentPushToken[clinch-'||id||']' WHERE id IN(${users.slice(0,count).map(q).join(',')});
            UPDATE notification_preferences SET event_settings=jsonb_set(event_settings,'{playoff_clinched}','true') WHERE user_id IN(${users.slice(0,4).map(q).join(',')});
            UPDATE notification_preferences SET event_settings=jsonb_set(event_settings,'{playoff_clinched}','false') WHERE user_id=${q(users[0])};
            UPDATE notification_preferences SET category_settings='{"playoff":false}' WHERE user_id=${q(users[1])};
            UPDATE notification_preferences SET master_enabled=false WHERE user_id=${q(users[2])};
            UPDATE notification_preferences SET event_settings=event_settings-'playoff_clinched' WHERE user_id=${q(users[4])};`)
          const nativeServe = Deno.serve, descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
          Object.defineProperty(Deno, 'serve', { value: (handler: Deno.ServeHandler) => { worker = nativeServe({ hostname: '127.0.0.1', port: 0, onListen() {} }, handler); return worker } })
          try { await import('../../functions/process-trades/index.ts') } finally { Object.defineProperty(Deno, 'serve', descriptor) }
          for (let drain=0;drain<4;drain++) {
            const response = await fetch(`http://127.0.0.1:${worker!.addr.port}`, { method:'POST', headers:{'x-internal-function-token':Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')!} })
            assert.equal(response.status,200,await response.text())
          }
          console.log(JSON.stringify({ transportEvidence: pushes.map(push => ({ to: push.to, event: push.data.notificationEvent, season: push.data.leagueSeasonId })), receiptRequests }))
          assert.equal(pushes.length,1)
          assert.equal(pushes[0].to,`ExponentPushToken[clinch-${users[3]}]`)
          assert.equal(pushes[0].data.notificationEvent,'playoff_clinched')
          assert.equal(pushes[0].data.leagueSeasonId,season)
          assert.ok(receiptRequests>0)
          assert.deepEqual(receivedTickets,issuedTickets)
          assert.equal(await sql(`SELECT count(*) FROM notification_outbox WHERE event_type='playoff_clinched' AND data->>'leagueSeasonId'=${q(season)} AND suppressed_at IS NOT NULL AND suppression_reason='preferences_disabled'`),'4')
          assert.equal(await sql(`SELECT count(*) FROM notification_outbox WHERE event_type='playoff_clinched' AND member_id=${q(members[3])} AND delivered_at IS NOT NULL AND expo_ticket_id IS NULL`),'1')
          console.log('PASS send-time event/category/master/default-off suppression; one opted-in fake Expo ticket and receipt; repeated drains send once')
        }
        if (year===2025 && !skipped && mode==='two') {
          await sql(`UPDATE leagues SET status='archived' WHERE id=${q(league)}; SELECT * FROM advance_season_atomic(${q(league)})`)
          assert.equal(await rows(),before,'Rollover preserves the season-scoped dedupe history')
        }
        console.log(JSON.stringify({ pass:true,year,skipped,mode,entrants,teamCount:count,clinched:clinched.length,provenance:'SYNTHETIC league and stats; REAL-DERIVED merged calendar' }))
      } catch (error) {
        failures.push(`${year}/${skipped}/${mode}: ${(error as Error).message}`)
        if (Deno.env.get('POST_CLINCH_RED')==='1') throw error
      } finally {
        await sql(`BEGIN; DELETE FROM notification_outbox WHERE member_id IN(SELECT id FROM league_members WHERE league_id IN(${q(league)},${q(foreignLeague)}));
          DELETE FROM draft_picks WHERE league_id=${q(league)}; DELETE FROM leagues WHERE id IN(${q(league)},${q(foreignLeague)});
          DELETE FROM player_game_stats WHERE game_id IN(${games.map(q).join(',')}); DELETE FROM nba_games WHERE id IN(${games.map(q).join(',')});
          DELETE FROM players WHERE id IN(${players.map(q).join(',')}); DELETE FROM auth.users WHERE id IN(${users.map(q).join(',')}); COMMIT;`)
      }
    }
  }
} finally {
  globalThis.fetch = nativeFetch
  await worker?.shutdown(); await fake.shutdown()
  await sql(`DELETE FROM season_weeks WHERE season_year IN(2025,2026) AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(${q(originalWeeks)}) old(season_year int,week_number int) WHERE old.season_year=season_weeks.season_year AND old.week_number=season_weeks.week_number);
    INSERT INTO season_weeks SELECT * FROM jsonb_populate_recordset(NULL::season_weeks,${q(originalWeeks)}) ON CONFLICT(season_year,week_number) DO UPDATE SET week_start=EXCLUDED.week_start,week_end=EXCLUDED.week_end`)
}
assert.deepEqual(failures,[])
