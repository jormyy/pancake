import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import path from 'node:path'

const port=process.env.PIPELINE_DB_PORT??'64822'
assert.ok(['64822','64222'].includes(port))
const url=`postgresql://postgres:postgres@127.0.0.1:${port}/postgres`
const freeze=source=>source.replace(/\b(?:now|transaction_timestamp|clock_timestamp)\(\)/g,'pg_temp.mix_now()')
const recipe=readFileSync('tests/db/pipeline-night-worker-mix.sql','utf8')
const marker='DELETE FROM private.work_items;'
const common=freeze(readFileSync('supabase/sql/functions/by-name/private/work_finish.sql','utf8'))
const results=[]
for(const ref of ['c84063c4','9894ce0c','candidate']){
  const source=ref==='candidate'?readFileSync('supabase/sql/functions/by-name/private/work_claim.sql','utf8'):
    execFileSync('git',['show',`${ref}:supabase/sql/functions/by-name/private/work_claim.sql`],{encoding:'utf8'})
  const input=recipe.replace(marker,()=>`${common}\n${freeze(source)}\n${marker}`)
  const output=execFileSync('psql',[url,'-XqAtv','ON_ERROR_STOP=1','-f','-'],{input,encoding:'utf8',cwd:path.resolve('tests/db'),maxBuffer:16*1024*1024})
  const result=JSON.parse(output.trim().split('\n').at(-1))
  assert.equal(result.checkBypasses,0,`${ref} passed an older eligible check`)
  results.push({ref,...result})
  process.stdout.write(JSON.stringify({ref,...result})+'\n')
}
const destination=process.env.PIPELINE_EVIDENCE??'/tmp/fable-l7/evidence'
mkdirSync(destination,{recursive:true})
writeFileSync(path.join(destination,'worker-mix.json'),JSON.stringify(results,null,2)+'\n')
if(process.env.PIPELINE_MIX_RED!=='1'){
  const candidate=results.at(-1)
  for(const kind of ['notification-scan','forecast-inputs','trade-revaluation-scan','trade-revaluation'])
    assert.ok(candidate.byKind[kind]?.firstTick<=6,`${kind} does not receive service within six ticks`)
  assert.equal(candidate.oldChecksCompleted,330)
  assert.equal(candidate.failedChecksCompleted,7)
  assert.equal(candidate.failedScanCompleted,1)
}
