import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

export async function runFeatureReview() {
  const lane = path.join(homedir(),'pancake-t_4ba51e0d/lanes/post')
  assert.equal(process.cwd(),path.join(lane,'repo'))
  const evidence = path.join(lane,'evidence/review8')
  mkdirSync(evidence,{recursive:true})
  const keys = Object.fromEntries(execFileSync('supabase',['status','-o','env'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split('\n').map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1).replace(/^"|"$/g,'')]}))
  for(const [url,port] of [[keys.API_URL,'57421'],[keys.DB_URL,'57422']]) { assert.ok(['127.0.0.1','localhost'].includes(new URL(url).hostname)); assert.equal(new URL(url).port,port) }
  const env={...process.env,SUPABASE_URL:keys.API_URL,SUPABASE_DB_URL:keys.DB_URL,PANCAKE_SUPABASE_SECRET_KEY:keys.SERVICE_ROLE_KEY,SUPABASE_SERVICE_ROLE_KEY:keys.SERVICE_ROLE_KEY,SUPABASE_ANON_KEY:keys.ANON_KEY,PANCAKE_TEST_API_PORT:'57421',PANCAKE_TEST_DB_PORT:'57422',PANCAKE_EDGE_INTERNAL_TOKEN:'local-database-ci-token'}
  const commands=[]
  const run=(name,binary,args,expected=0)=>{
    const start=performance.now(), result=spawnSync(binary,args,{env,encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024})
    const log=path.join(evidence,`${name}.log`)
    const command=`${binary} ${args.map(arg=>arg===keys.DB_URL?'"$SUPABASE_DB_URL"':arg).join(' ')}`
    writeFileSync(log,`${command}\n${result.stdout??''}${result.stderr??''}\nexit=${result.status} signal=${result.signal}\n`)
    const row={name,command,exit:result.status,seconds:Math.round((performance.now()-start)/10)/100,log}
    commands.push(row);writeFileSync(path.join(evidence,`commands${process.argv.includes('--features-draft-red')?'-draft-red':process.argv.includes('--features-draft-green')?'-draft-green':process.argv.includes('--features-red')?'-red':process.argv.includes('--features-static')?'-static':''}.json`),JSON.stringify(commands,null,2)+'\n');console.log(JSON.stringify(row))
    assert.equal(result.status,expected,log)
    return result.stdout
  }
  if(process.argv.includes('--features-static')) {
    const changed = ['app/(modals)/commissioner-settings.tsx','core/src/season/schedule.ts','hooks/use-commissioner-settings-resource.ts','lib/commissioner-settings-draft.ts','scripts/mutation/post/feature-review.mjs','scripts/mutation/post/feature-browser.mjs','scripts/mutation/post/integration.mjs','scripts/mutation/post/report.mjs','supabase/functions/_shared/seasonBoundary.ts','supabase/tests/db/rookie-backstop.ts','supabase/functions/_shared/matchupGeneration.ts','supabase/functions/_shared/schedule.ts','supabase/functions/api/league.ts','supabase/functions/api/matchups.test.ts','supabase/functions/api/matchups.ts','supabase/tests/db/calendar-publish.ts','supabase/tests/db/matchup-order-seasons.ts','tests/lib/commissioner-settings-fit.test.ts','tests/hooks/commissioner-settings-resource.test.ts']
    run('eslint','npx',['eslint',...changed])
    run('deno-check','deno',['check','--no-lock','supabase/functions/_shared/seasonBoundary.ts','supabase/tests/db/rookie-backstop.ts','supabase/functions/api/league.ts','supabase/functions/api/matchups.ts','supabase/tests/db/calendar-publish.ts','supabase/tests/db/matchup-order-seasons.ts'])
    run('db-sources','node',['scripts/check-db-function-sources.mjs','--check'])
    run('edge-shared','node',['scripts/generate-edge-shared.mjs','--check'])
    run('matchups-unit','deno',['test','--no-lock','--allow-env','--allow-net=127.0.0.1,localhost','supabase/functions/api/matchups.test.ts'])
    run('boundary-unit','deno',['test','--no-lock','--allow-env','--allow-read','--allow-net=127.0.0.1,localhost','supabase/functions/_shared/seasonBoundaryCalendar.test.ts','supabase/functions/_shared/seasonBoundaryFailures.test.ts','supabase/functions/_shared/octoberGap.test.ts'])
    run('edge-functions','npm',['run','check:edge-functions'])
    run('vitest','npx',['vitest','run','tests/lib/commissioner-settings-draft.test.ts','tests/lib/commissioner-settings-fit.test.ts','tests/hooks/commissioner-settings-resource.test.ts'])
    run('core-vitest','npm',['--prefix','core','test','--','tests/calendar.test.ts'])
    run('typecheck-e2e','npm',['run','typecheck:e2e'])
    run('knip','npm',['run','check:dead-code'])
    return
  }
  if(process.argv.includes('--features-draft-red') || process.argv.includes('--features-draft-green')) {
    const sql=statement=>execFileSync('psql',[keys.DB_URL,'-XqAtv','ON_ERROR_STOP=1','-c',statement],{env,encoding:'utf8'})
    const symbol='public.start_rookie_draft_atomic(uuid,integer,boolean,integer,text)'
    const before=sql(`SELECT pg_get_functiondef('${symbol}'::regprocedure)`)
    const hash=value=>createHash('sha256').update(value).digest('hex')
    const red=process.argv.includes('--features-draft-red')
    try {
      sql(readFileSync(path.join(evidence,'draft-start-proposed.sql'),'utf8'))
      run(red?'red/rookie-missing-timer':'green/rookie-missing-timer','env',['POST_ROOKIE_CASE=missing','node','scripts/mutation/post/check.mjs','supabase/tests/db/rookie-backstop.ts'],red?1:0)
      if(!red) {
        run('green/rookie-backstop-integrated','node',['scripts/mutation/post/check.mjs','supabase/tests/db/rookie-backstop.ts'])
        run('green/rookie-skipped-integrated','node',['scripts/mutation/post/check.mjs','supabase/tests/db/rookie-skipped-week.ts'])
        run('green/season-boundary-et-integrated','npm',['run','test:db:season-boundary-et'])
      }
    } finally { sql(before); assert.equal(hash(sql(`SELECT pg_get_functiondef('${symbol}'::regprocedure)`)),hash(before));console.log('Draft integration overlay restored by SHA-256') }
    if (!red) {
      for (let pass=1;pass<=2;pass++) run(`green/rookie-backstop-baseline-${pass}`,'node',['scripts/mutation/post/check.mjs','supabase/tests/db/rookie-backstop.ts'])
      run('green/rookie-skipped-baseline','node',['scripts/mutation/post/check.mjs','supabase/tests/db/rookie-skipped-week.ts'])
    }
    return
  }
  if(process.argv.includes('--features-red')) {
    const sql=statement=>execFileSync('psql',[keys.DB_URL,'-XqAtv','ON_ERROR_STOP=1','-c',statement],{env,encoding:'utf8'})
    const before=sql("SELECT pg_get_functiondef('private.regular_season_matchup_payload(uuid,uuid,integer)'::regprocedure)")
    const hash=value=>createHash('sha256').update(value).digest('hex')
    try {
      sql(readFileSync(path.join(evidence,'red/base-matchup.sql'),'utf8'))
      run('red/matchup-order-final','node',['scripts/mutation/post/check.mjs','tests/db/matchup-order-fairness.sql'],3)
      run('red/matchup-order-season-repeat','psql',[keys.DB_URL,'-Xv','ON_ERROR_STOP=1','-c',"SET post.order_case='season'",'-f','tests/db/matchup-order-fairness.sql'],3)
    } finally { sql(before); assert.equal(hash(sql("SELECT pg_get_functiondef('private.regular_season_matchup_payload(uuid,uuid,integer)'::regprocedure)")),hash(before));console.log('Red application overlay restored by SHA-256') }
    return
  }
  run('fairness-port-guard','env',['PANCAKE_TEST_DB_PORT=54322','psql',keys.DB_URL,'-Xv','ON_ERROR_STOP=1','-f','tests/db/matchup-order-fairness.sql'],3)
  for(let pass=1;pass<=2;pass++) {
    run(`pass${pass}-calendar-entry`,'node',['scripts/mutation/post/check.mjs','supabase/tests/db/calendar-publish.ts'])
    run(`pass${pass}-fairness`,'node',['scripts/mutation/post/check.mjs','tests/db/matchup-order-fairness.sql'])
    const output=run(`pass${pass}-real-seasons`,'node',['scripts/mutation/post/check.mjs','supabase/tests/db/matchup-order-seasons.ts'])
    for(const line of output.split('\n').filter(line=>line.startsWith('FEATURE_EVIDENCE '))) {
      const result=JSON.parse(line.slice('FEATURE_EVIDENCE '.length)), label=`${result.year-1}-${result.year}`
      for(const directory of ['matchup-order','playoffs']) mkdirSync(path.join(lane,'evidence',directory),{recursive:true})
      writeFileSync(path.join(lane,'evidence/matchup-order',`${label}.tsv`),'week\tstart\tend\thome\taway\n'+result.matchups.map(row=>{const week=result.weeks.find(week=>week.week_number===row.week);return`${row.week}\t${week.week_start}\t${week.week_end}\tTeam ${row.home}\tTeam ${row.away}`}).join('\n')+'\n')
      writeFileSync(path.join(lane,'evidence/playoffs',`${label}.md`),`# ${label}\n\n${result.provenance}. Pinned inputs: tests/fixtures/calendar/espn-${label}.json. Local product RPCs publish the calendar, update skipped weeks, generate matchups and build/advance the bracket. Scores are synthetic direct fixture writes. This is not a historical replay.\n\nSeeds: ${result.seeds.join(', ')}. Seeds 1 and 2 receive byes. Champion: Team ${result.champion}, the finalized playoff_final winner.\n\n| Round | Weeks | Dates | Home | Away | Winner |\n|---|---|---|---|---|---|\n`+result.bracket.map(row=>`| ${row.round} | ${row.start}–${row.end} | ${result.weeks.find(week=>week.week_number===row.start).week_start}–${result.weeks.find(week=>week.week_number===row.end).week_end} | ${row.home} | ${row.away} | ${row.winner} |`).join('\n')+'\n\nAll playoff weeks end on or before the last regular-season game day. Week 1 is skipped. The merged All-Star matchup remains week 17. Eliminated teams do not return to later rounds. Existing playoff-ranking-priority and general-playoff-brackets recipes cover tiebreak priority; playoff-stale-boundary covers certified automatic progression and rollover; scoring elimination remains a reused scoring oracle, not a claim from the fixture writes here.\n')
    }
  }
  if (process.argv.includes('--features-only')) return
  const scripts=JSON.parse(readFileSync('package.json','utf8')).scripts
  for(const [name,command] of Object.entries(scripts)) if(name.startsWith('test:db:') && /playoff-|general-playoff|season-boundary|three-season/.test(String(command))) run(name.replaceAll(':','-'),'npm',['run',name])
  run('rookie-skipped-week','npm',['run','evidence:db:rookie-skipped-week'])
  run('matchups-unit','deno',['test','--no-lock','--allow-env','--allow-net=127.0.0.1,localhost','supabase/functions/api/matchups.test.ts'])
  run('boundary-unit','deno',['test','--no-lock','--allow-env','--allow-read','--allow-net=127.0.0.1,localhost','supabase/functions/_shared/seasonBoundaryCalendar.test.ts','supabase/functions/_shared/seasonBoundaryFailures.test.ts','supabase/functions/_shared/octoberGap.test.ts'])
}
