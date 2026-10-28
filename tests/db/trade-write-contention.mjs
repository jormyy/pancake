import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { databaseTarget } from '../../scripts/mutation/waivers/targets.mjs'

export async function runTradeWriteContention(immediate = false) {
  const target = databaseTarget().href
  const query = sql => execFileSync('psql', [target, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
  const support = readFileSync(new URL('./rules-support.sql', import.meta.url), 'utf8')
  const f = JSON.parse(query(`BEGIN;
${support}
WITH f AS MATERIALIZED(SELECT * FROM pg_temp.rules_fixture(2,9564)),
w AS(INSERT INTO private.work_items(kind,key,payload)
  SELECT 'process-trades',f.league_id::text,jsonb_build_object('contention',f.league_id) FROM f RETURNING id)
SELECT jsonb_build_object('leagueId',f.league_id,'seasonId',f.season_id,'userId',f.user_ids[2],
  'memberId',f.member_ids[2],'recipientId',f.member_ids[1],'recipientUserId',f.user_ids[1],'workId',w.id) FROM f,w;
COMMIT;`))
  if (immediate) query(`UPDATE public.leagues SET trade_veto_mode='disabled' WHERE id='${f.leagueId}';`)
  let holder
  const hold = async mode => {
    holder = spawn('psql', [target, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] })
    await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('The lock holder did not become ready.')), 5000)
      holder.once('error', reject)
      holder.once('exit', code => { if (code) reject(new Error(`Lock holder failed: ${code}`)) })
      holder.stdout.on('data', chunk => {
        output += chunk
        if (output.includes('locked')) { clearTimeout(timer); resolve() }
      })
      holder.stdin.write(`BEGIN;
SELECT id FROM public.leagues WHERE id='${f.leagueId}' FOR ${mode};
SELECT id FROM private.work_items WHERE id=${f.workId} FOR UPDATE;
SELECT league_season_id FROM private.screen_refresh_queue WHERE league_id='${f.leagueId}' FOR UPDATE;
SELECT league_id FROM public.league_versions WHERE league_id='${f.leagueId}' FOR UPDATE;
SELECT 'locked';
`)
    })
  }
  const release = async () => {
    if (!holder || holder.exitCode !== null) return
    const process = holder
    await new Promise((resolve, reject) => {
      process.once('exit', code => code === 0 ? resolve() : reject(new Error(`Lock holder exit: ${code}`)))
      process.stdin.end('ROLLBACK;\n')
    })
    holder = undefined
  }
  const propose = () => query(`SET statement_timeout='8s';
SELECT public.submit_trade_offer_atomic('${f.userId}',gen_random_uuid(),'${f.memberId}','propose',
jsonb_build_object('leagueId','${f.leagueId}','leagueSeasonId','${f.seasonId}',
'recipientMemberId','${f.recipientId}','offerFaabAmount',1,'requestFaabAmount',2));`)
  try {
    await hold('KEY SHARE')
    let started = performance.now()
    const tradeId = propose()
    const proposeMs = performance.now() - started
    assert(proposeMs < 1000, `Proposal took ${proposeMs} ms behind scheduler locks.`)
    started = performance.now()
    query(`SET statement_timeout='8s'; SELECT public.accept_trade_atomic('${tradeId}','${f.recipientId}');`)
    const acceptMs = performance.now() - started
    assert(acceptMs < 1000, `Acceptance took ${acceptMs} ms behind scheduler locks.`)
    assert.equal(query(`SELECT status FROM public.trades WHERE id='${tradeId}';`), immediate ? 'completed' : 'accepted')
    await release()
    await hold('UPDATE')
    started = performance.now()
    assert.throws(propose, /The league is busy\. Try this trade again\./)
    const busyMs = performance.now() - started
    assert(busyMs < 1000, `A fully locked league took ${busyMs} ms to reject.`)
    return { immediate, proposeMs, acceptMs, busyMs }
  } finally {
    await release()
    query(`DELETE FROM private.work_items WHERE id=${f.workId} OR payload->>'tradeId' IN
      (SELECT id::text FROM public.trades WHERE league_id='${f.leagueId}');
DO $cleanup$ BEGIN IF to_regclass('private.trade_publications') IS NOT NULL THEN
  EXECUTE 'DELETE FROM private.work_items WHERE payload->>''publicationId'' IN (SELECT id::text FROM private.trade_publications WHERE league_id=''${f.leagueId}'')';
  EXECUTE 'DELETE FROM private.trade_publications WHERE league_id=''${f.leagueId}''';
END IF; END $cleanup$;
DELETE FROM public.leagues WHERE id='${f.leagueId}';`)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) console.log(JSON.stringify(await runTradeWriteContention()))
