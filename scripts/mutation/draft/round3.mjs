import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from './clock-stack.mjs'

const root=resolve('evidence/round3/mutation')
mkdirSync(root,{recursive:true})
const cases=[
  {id:'restart-pause-second',part:'A',symbol:'public.pause_draft_atomic(uuid,uuid)',file:'supabase/migrations/20261020000200_rookie_draft_long_timers.sql',original:'CEIL(EXTRACT(EPOCH FROM (timer_expires_at - v_now)))::int',mutated:'CEIL(EXTRACT(EPOCH FROM (timer_expires_at - v_now)))::int + 1',operator:'arithmetic + 1 saved second',oracle:'tests/e2e/draft-timer-restart-real.mjs',args:['--state-only']},
  {id:'restart-resume-full',part:'A',symbol:'public.resume_draft_atomic(uuid,uuid)',file:'supabase/migrations/20261020000200_rookie_draft_long_timers.sql',original:'COALESCE(v_draft.timer_paused_remaining_seconds,',mutated:'COALESCE(NULL::int,',operator:'replace persisted remaining argument with NULL',oracle:'tests/e2e/draft-timer-restart-real.mjs',args:['--state-only']},
  {id:'cutoff-exact-second',part:'B',symbol:'private.draft_timer_complete_opening_night(integer,timestamp with time zone)',file:'supabase/migrations/20261020000206_complete_skipped_rookie_picks_at_opening.sql',original:'<= p_at',mutated:'< p_at',operator:'relational <= -> <',oracle:'tests/db/draft-timer-cutoff.mjs',args:[]},
  {id:'cutoff-skipped-recovery',part:'B',symbol:'private.draft_timer_complete_opening_night(integer,timestamp with time zone)',file:'supabase/migrations/20261020000206_complete_skipped_rookie_picks_at_opening.sql',original:'SET skipped_at=NULL, skip_reason=NULL',mutated:'SET skipped_at=skipped_at, skip_reason=skip_reason',operator:'remove clearing skipped markers',oracle:'tests/db/draft-timer-cutoff.mjs',args:[]},
]
const hash=value=>createHash('sha256').update(value).digest('hex')
function oracle(item,name) {
  const command=['node',item.oracle,...item.args]
  const begin=performance.now()
  const result=spawnSync(command[0],command.slice(1),{encoding:'utf8',env:{...process.env,DRAFT_CLOCK_EVIDENCE_DIR:resolve(root,name)},timeout:180000,maxBuffer:1024*1024})
  const log=resolve(root,name+'.log');writeFileSync(log,(result.stdout??'')+(result.stderr??''))
  const record={name,command:command.join(' '),exit:result.status??124,seconds:Number(((performance.now()-begin)/1000).toFixed(3)),log}
  console.log(JSON.stringify(record));return record
}
for(const part of ['A','B']) {
  const item=cases.find(c=>c.part===part)
  assert.equal(oracle(item,`baseline-${part}`).exit,0)
  for(const target of cases.filter(c=>c.part===part)) {
    const original=sql(`SELECT pg_get_functiondef('${target.symbol}'::regprocedure)`)
    assert(original.includes(target.original))
    let applied=false,outcome='invalid',notes='',oracles=[]
    try {
      sql(original.replace(target.original,target.mutated));applied=true
      const result=oracle(target,target.id);oracles=[result]
      outcome=result.exit===124?'timeout':result.exit===0?'survived':'killed'
      notes=outcome==='killed'?'The valid fixture reaches the changed application rule and fails its behavior check.':'Requires classification.'
    } catch(error) {
      notes=String(error)
    } finally {
      sql(original);assert.equal(hash(sql(`SELECT pg_get_functiondef('${target.symbol}'::regprocedure)`)),hash(original))
    }
    const source=readFileSync(target.file,'utf8'),start=source.indexOf('CREATE OR REPLACE FUNCTION '+target.symbol.split('(')[0]+'(')
    const line=source.slice(0,source.indexOf(target.original,start)).split('\n').length
    appendFileSync(resolve(root,'results.jsonl'),JSON.stringify({id:target.id,area:'draft-timer',file:target.file,line,symbol:target.symbol,operator:target.operator,original:target.original,mutated:target.mutated,applied,outcome,oracles,killed_by:outcome==='killed'?oracles.map(x=>x.name):[],notes})+'\n')
    assert.equal(outcome,'killed')
  }
  assert.equal(oracle(item,`restored-${part}`).exit,0)
}
