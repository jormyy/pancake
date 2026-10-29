import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { connectionEnvironment } from '../../scripts/db-health/index.mjs'

async function checkConflict(setup, first, second, cleanup, expected) {
  const env = connectionEnvironment(process.env.SUPABASE_DB_URL)
  const args = ['-XqAt', '-v', 'ON_ERROR_STOP=1']
  const run = sql => {
    const result = spawnSync('psql', args, { env, input: sql, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  run(setup)
  const holder = spawn('psql', args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let contender
  try {
    const marker = randomUUID()
    let holderError = ''
    holder.stderr.on('data', chunk => { holderError += chunk })
    const ready = new Promise((resolve, reject) => {
      let output = ''
      holder.stdout.on('data', chunk => { output += chunk; if (output.includes(marker)) resolve() })
      holder.on('exit', code => { if (code) reject(new Error(holderError)) })
    })
    holder.stdin.write(`BEGIN; ${first}\n\\echo ${marker}\n`)
    await ready
    contender = spawn('psql', args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let error = '', settled = false
    contender.stderr.on('data', chunk => { error += chunk })
    const done = new Promise(resolve => contender.once('exit', code => { settled = true; resolve(code) }))
    contender.stdin.end(second)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(settled, false, 'The conflicting transaction must wait for the first identity')
    const committed = new Promise(resolve => holder.once('exit', resolve))
    holder.stdin.end('COMMIT;\n')
    assert.equal(await committed, 0, holderError)
    assert.notEqual(await done, 0)
    assert.match(error, expected)
  } finally {
    holder.kill('SIGTERM')
    contender?.kill('SIGTERM')
    run(cleanup)
  }
}

test('stats identity conflicts serialize across seasons', { skip: process.env.PARTITION_DB_TESTS !== '1' }, async () => {
  const player = randomUUID(), gameA = randomUUID(), gameB = randomUUID(), identity = randomUUID()
  await checkConflict(
    `INSERT INTO public.players(id,first_name,last_name,position,eligible_positions) VALUES('${player}','Partition','Concurrency','PG',ARRAY['PG']);
     INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
     VALUES('${gameA}','002${gameA}',2097,1,'2096-10-20','BOS','LAL','Final'),('${gameB}','002${gameB}',2098,1,'2097-10-20','BOS','LAL','Final');`,
    `INSERT INTO public.player_game_stats(id,player_id,game_id,season_year,week_number) VALUES('${identity}','${player}','${gameA}',2097,1);`,
    `INSERT INTO public.player_game_stats(id,player_id,game_id,season_year,week_number) VALUES('${identity}','${player}','${gameB}',2098,1);`,
    `DELETE FROM public.player_game_stats WHERE player_id='${player}'; DELETE FROM public.nba_games WHERE id IN('${gameA}','${gameB}'); DELETE FROM public.players WHERE id='${player}';`,
    /Duplicate player stats identity across seasons/,
  )
})

test('outbox dedupe conflicts serialize across months', { skip: process.env.PARTITION_DB_TESTS !== '1' }, async () => {
  const key = randomUUID(), user = randomUUID(), league = randomUUID(), member = randomUUID()
  const columns = 'dedupe_key,member_id,event_type,title,body,data,category,created_at'
  const values = `'${key}','${member}','partition-concurrency','same','same','{}','draft'`
  await checkConflict(
    `INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES('${user}','${user}@example.test','{}');
     INSERT INTO public.leagues(id,name,slug,commissioner_id) VALUES('${league}','Partition fixture','${league}','${user}');
     INSERT INTO public.league_members(id,league_id,user_id,role,team_name) VALUES('${member}','${league}','${user}','commissioner','Partition');`,
    `INSERT INTO public.notification_outbox(${columns}) VALUES(${values},date_trunc('month',now()));`,
    `INSERT INTO public.notification_outbox(${columns}) VALUES(${values},date_trunc('month',now())-interval '1 month');`,
    `DELETE FROM public.notification_outbox WHERE dedupe_key='${key}'; DELETE FROM public.leagues WHERE id='${league}'; DELETE FROM auth.users WHERE id='${user}';`,
    /notification_outbox_dedupe_key_key/,
  )
})
