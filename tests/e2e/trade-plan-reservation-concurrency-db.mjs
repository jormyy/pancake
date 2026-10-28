import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const url = process.env.SUPABASE_DB_URL
assert(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Use an isolated local database')
const ids = Array.from({ length: 12 }, () => randomUUID())
const [league, season, player, ...rest] = ids
const users = rest.slice(0, 3)
const members = rest.slice(3, 6)
const trades = rest.slice(6, 8)

function query(sql) {
    return new Promise((resolve, reject) => {
        const child = spawn('psql', [url, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql])
        let output = ''
        let error = ''
        child.stdout.on('data', (chunk) => { output += chunk })
        child.stderr.on('data', (chunk) => { error += chunk })
        child.on('error', reject)
        child.on('close', (code) => resolve({ code, output, error }))
    })
}

try {
    const fixture = await query(`BEGIN;
      INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      SELECT id,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now() FROM unnest(ARRAY[${users.map((id) => `'${id}'::uuid`).join(',')}]) id;
      INSERT INTO leagues(id,name,slug,commissioner_id,status,allow_inactive_trades) VALUES('${league}','Plan concurrency','${league}','${users[0]}','active',true);
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES('${season}','${league}',8400,true);
      ${members.map((id, index) => `INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES('${id}','${league}','${users[index]}','${index === 0 ? 'commissioner' : 'manager'}','Concurrent ${index}');`).join('\n')}
      INSERT INTO players(id,first_name,last_name) VALUES('${player}','Concurrent','Drop');
      INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES('${league}','${season}','${members[0]}','${player}','draft');
      ${trades.map((id, index) => `INSERT INTO trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,status) VALUES('${id}','${league}','${season}','${members[0]}','${members[index + 1]}','pending');
      INSERT INTO trade_participants(trade_id,member_id,sort_order,is_initiator) VALUES('${id}','${members[0]}',0,true),('${id}','${members[index + 1]}',1,false);
      INSERT INTO trade_items(trade_id,side,faab_amount,from_member_id,to_member_id) VALUES('${id}','proposer',1,'${members[0]}','${members[index + 1]}');`).join('\n')}
      COMMIT;`)
    assert.equal(fixture.code, 0, fixture.error)
    const results = await Promise.all(trades.map((id) => query(`BEGIN; SET LOCAL statement_timeout='15s';
      SELECT set_trade_roster_plan_atomic('${id}','${members[0]}','${users[0]}','{}','{}',ARRAY['${player}'::uuid]);
      SELECT pg_sleep(0.2); COMMIT;`)))
    assert.equal(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results))
    assert.match(results.find((result) => result.code !== 0).error, /reserved.*another trade|The league is busy/)
    const stored = await query(`SELECT count(*) FROM trade_participants WHERE trade_id IN('${trades.join("','")}') AND '${player}'::uuid=ANY(drop_player_ids);`)
    assert.equal(stored.output.trim(), '1')
    console.log('PASS: two concurrent plan reservations produce exactly one winner; one stored reservation')
} finally {
    const cleanup = await query(`DELETE FROM trades WHERE league_id='${league}'; DELETE FROM leagues WHERE id='${league}'; DELETE FROM players WHERE id='${player}'; DELETE FROM auth.users WHERE id IN('${users.join("','")}');`)
    assert.equal(cleanup.code, 0, cleanup.error)
}
