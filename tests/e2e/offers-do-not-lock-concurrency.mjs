import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const db = process.env.SUPABASE_DB_URL
assert(db)
const url = new URL(db)
assert(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === (process.env.PANCAKE_TEST_DB_PORT ?? '63822'), 'Use only the assigned private database')
const quote = value => `'${String(value).replaceAll("'", "''")}'`
const list = values => values.map(quote).join(',')
function query(sql) {
    return new Promise((resolve, reject) => {
        const child = spawn('psql', [db, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
            env: { ...process.env, PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=3000' },
        })
        let output = '', error = ''
        child.stdout.on('data', data => { output += data })
        child.stderr.on('data', data => { error += data })
        child.on('error', reject)
        child.on('close', code => resolve({ code, output: output.trim(), error }))
    })
}
async function ok(sql) {
    const result = await query(sql)
    assert.equal(result.code, 0, result.error)
    return result.output
}
for (let round = 1; round <= 5; round += 1) {
    const league = randomUUID(), season = randomUUID()
    const users = Array.from({ length: 3 }, randomUUID)
    const members = Array.from({ length: 3 }, randomUUID)
    const players = Array.from({ length: 3 }, randomUUID)
    let offers = []
    try {
        await ok(`BEGIN;
          INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
          SELECT id,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now() FROM unnest(ARRAY[${list(users)}]::uuid[]) id;
          INSERT INTO leagues(id,name,slug,commissioner_id,status,trade_veto_mode,trade_veto_window_hours)
          VALUES(${quote(league)},'Offer accept race',${quote(league)},${quote(users[0])},'active','commissioner',24);
          INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${quote(season)},${quote(league)},9605,true);
          ${members.map((id, i) => `INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${quote(id)},${quote(league)},${quote(users[i])},'${i === 0 ? 'commissioner' : 'manager'}','Race ${i}');`).join('\n')}
          INSERT INTO players(id,first_name,last_name,position,eligible_positions) SELECT id,'Offer race',id::text,'PG',ARRAY['PG'] FROM unnest(ARRAY[${list(players)}]::uuid[]) id;
          ${members.map((id, i) => `INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(${quote(league)},${quote(season)},${quote(id)},${quote(players[i])},'draft');`).join('\n')}
          COMMIT;`)
        for (const i of [1, 2]) {
            offers.push(await ok(`SET ROLE service_role; SELECT public.propose_trade_atomic(${quote(league)},${quote(season)},${quote(members[0])},${quote(members[i])},ARRAY[${quote(players[0])}]::uuid[],ARRAY[${quote(players[i])}]::uuid[],'{}','{}');`))
        }
        assert(offers.every(id => /^[0-9a-f-]{36}$/.test(id)))
        const results = await Promise.all(offers.map((offer, i) => query(`BEGIN; SET LOCAL ROLE service_role;
          SELECT pg_sleep(0.1); SELECT public.accept_trade_atomic(${quote(offer)},${quote(members[i + 1])}); SELECT pg_sleep(0.3); COMMIT;`)))
        assert.equal(results.filter(result => result.code === 0).length, 1, JSON.stringify(results))
        const loser = results.find(result => result.code !== 0)
        assert.match(loser.error, /The league is busy|no longer pending|Locked by trade/)
        assert.doesNotMatch(loser.error, /deadlock detected|statement timeout/)
        assert.equal(await ok(`SELECT count(*) FILTER(WHERE status='accepted')||':'||count(*) FILTER(WHERE status='withdrawn') FROM trades WHERE id IN(${list(offers)});`), '1:1')
        const winnerIndex = results.findIndex(result => result.code === 0)
        const winner = offers[winnerIndex], cancelled = offers[1 - winnerIndex]
        assert.equal(await ok(`SELECT count(*) FROM notification_outbox WHERE data->>'tradeId'=${quote(cancelled)} AND event_type='trade_withdrawn' AND title='Trade Cancelled';`), '2')
        const retry = await query(`SET ROLE service_role; SELECT public.accept_trade_atomic(${quote(cancelled)},${quote(members[2 - winnerIndex])});`)
        assert.notEqual(retry.code, 0)
        assert.match(retry.error, /no longer pending/)
        await ok(`UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=${quote(winner)};
          SET ROLE service_role; SELECT public.complete_accepted_trade_atomic(${quote(winner)});`)
        assert.equal(await ok(`SELECT member_id FROM roster_players WHERE league_season_id=${quote(season)} AND player_id=${quote(players[0])};`), members[winnerIndex + 1])
        assert.equal(await ok(`SELECT count(*) FROM trades WHERE id IN(${list(offers)}) AND status='completed';`), '1')
        console.log(`PASS round ${round}: one accepted, one cancelled, two notifications, one transfer, clean retry`)
    } finally {
        await ok(`DELETE FROM leagues WHERE id=${quote(league)};
          DELETE FROM players WHERE id IN(${list(players)});
          DELETE FROM auth.users WHERE id IN(${list(users)});`)
    }
}
console.log('PASS: 5 acceptance races, 50 assertions')
