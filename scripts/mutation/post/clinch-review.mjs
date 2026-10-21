import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export function runClinchReview() {
  const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/post')
  assert.equal(process.cwd(), path.join(lane, 'repo'))
  const evidence = path.join(lane, 'evidence/review10')
  const keys = Object.fromEntries(execFileSync('supabase', ['status','-o','env'], { encoding:'utf8',stdio:['ignore','pipe','ignore'] }).trim().split('\n').map(line => {
    const at=line.indexOf('='); return [line.slice(0,at),line.slice(at+1).replace(/^"|"$/g,'')]
  }))
  for (const [url,port] of [[keys.API_URL,'57421'],[keys.DB_URL,'57422']]) {
    assert.ok(['127.0.0.1','localhost'].includes(new URL(url).hostname)); assert.equal(new URL(url).port,port)
  }
  const env={...process.env,PATH:`${lane}/bin:${process.env.PATH}`,DOCKER_CONFIG:path.join(lane,'docker-config'),SUPABASE_URL:keys.API_URL,SUPABASE_DB_URL:keys.DB_URL,PANCAKE_SUPABASE_SECRET_KEY:keys.SERVICE_ROLE_KEY,
    PANCAKE_TEST_API_PORT:'57421',PANCAKE_TEST_DB_PORT:'57422',PANCAKE_EDGE_INTERNAL_TOKEN:'local-database-ci-token'}
  const mode=process.argv.includes('--clinch-static')?'static':process.argv.includes('--clinch-red')?'red':'green'
  mkdirSync(path.join(evidence,mode),{recursive:true})
  const rows=[]
  const run=(name,binary,args,expected=0,cwd=process.cwd())=>{
    const start=performance.now(),result=spawnSync(binary,args,{env,cwd,encoding:'utf8',timeout:240000,maxBuffer:16*1024*1024})
    const command=`${binary} ${args.map(arg=>arg===keys.DB_URL?'"$SUPABASE_DB_URL"':arg).join(' ')}`,log=path.join(evidence,mode,`${name}.log`)
    writeFileSync(log,`${command}\n${result.stdout??''}${result.stderr??''}\nexit=${result.status} signal=${result.signal}\n`)
    const row={name,command,cwd,exit:result.status,seconds:Math.round((performance.now()-start)/10)/100,log}
    rows.push(row);writeFileSync(path.join(evidence,`commands-${mode}.json`),JSON.stringify(rows,null,2)+'\n');console.log(JSON.stringify(row))
    assert.equal(result.status,expected,log)
  }
  if(mode==='red') {
    const sql=statement=>execFileSync('psql',[keys.DB_URL,'-XqAtv','ON_ERROR_STOP=1'],{env,input:statement,encoding:'utf8'})
    try {
      sql('ALTER TABLE standings DISABLE TRIGGER playoff_clinched_standings_insert; ALTER TABLE standings DISABLE TRIGGER playoff_clinched_standings_update;')
      run('final-fixture-no-producer','env',['POST_CLINCH_RED=1','node','scripts/mutation/post/check.mjs','supabase/tests/db/playoff-clinched.ts'],1)
    } finally { sql('ALTER TABLE standings ENABLE TRIGGER playoff_clinched_standings_insert; ALTER TABLE standings ENABLE TRIGGER playoff_clinched_standings_update;') }
    return
  }
  if(mode==='static') {
    run('eslint','npx',['eslint','scripts/mutation/post/clinch-review.mjs','scripts/mutation/post/integration.mjs','scripts/mutation/post/report.mjs','supabase/tests/db/playoff-clinched.ts','--max-warnings=0'])
    run('deno','deno',['check','--no-lock','supabase/tests/db/playoff-clinched.ts'])
    run('db-sources','node',['scripts/check-db-function-sources.mjs','--check'])
    run('edge-shared','node',['scripts/generate-edge-shared.mjs','--check'])
    run('db-types','npm',['run','check:database-types'])
    run('catalog-before-registration','npm',['run','check:db-function-catalog'],1)
    const view=mkdtempSync(path.join(evidence,'catalog-view-'))
    try {
      mkdirSync(path.join(view,'supabase/sql'),{recursive:true})
      symlinkSync(path.join(lane,'repo/supabase/sql/functions'),path.join(view,'supabase/sql/functions'))
      symlinkSync(path.join(lane,'repo/supabase/migrations'),path.join(view,'supabase/migrations'))
      const checker=path.join(lane,'repo/scripts/check-db-function-sources.mjs')
      run('generate-catalog-proposal','node',[checker,'--write-catalog-manifest'],0,view)
      writeFileSync(path.join(evidence,'function-catalog.proposed.json'),readFileSync(path.join(view,'supabase/sql/function-catalog.json')))
      run('catalog-with-proposal','node',[checker,'--check-catalog'],0,view)
    } finally { rmSync(view,{recursive:true,force:true}) }
    run('knip-before-registration','npm',['run','check:dead-code'],1)
    const config=JSON.parse(readFileSync('knip.json','utf8'))
    config.workspaces['.'].entry.push('supabase/tests/db/playoff-clinched.ts')
    const proposed=path.join(evidence,'knip.proposed.json')
    writeFileSync(proposed,JSON.stringify(config,null,2)+'\n')
    run('knip-with-proposal','npx',['knip','--config',proposed,'--no-progress','--no-config-hints'])
    run('typecheck-e2e','npm',['run','typecheck:e2e'])
    return
  }
  for(let pass=1;pass<=2;pass++) run(`clinch-${pass}`,'node',['scripts/mutation/post/check.mjs','supabase/tests/db/playoff-clinched.ts'])
  for(const name of ['playoff-ranking-priority','general-brackets','playoff-branches','playoff-windows','rookie-backstop']) run(name,'npm',['run',`test:db:${name}`])
}
