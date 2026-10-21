import assert from'node:assert/strict'
import test from'node:test'
import{mkdtemp,mkdir,readFile,writeFile,symlink,realpath}from'node:fs/promises'
import{tmpdir}from'node:os'
import path from'node:path'
import{criteria}from'./criteria.mjs'
import{criterionStatus,estimateCriterion,summarizeProgress,readProgress,assertOutput}from'./progress.mjs'

const find=id=>criteria.find(row=>row.id===id)

test('the matrix covers every requirement line, all 44 events and five missing producers',()=>{
  for(const line of[1,3,...Array.from({length:20},(_,i)=>i+6)])assert.ok(criteria.some(row=>row.briefLines.includes(line)),`brief line ${line}`)
  for(let feature=1;feature<=7;feature++)assert.ok(criteria.some(row=>row.features.includes('F'+feature)))
  const events=criteria.filter(row=>row.id.startsWith('event:'))
  assert.equal(events.length,44)
  assert.equal(new Set(criteria.map(row=>row.id)).size,criteria.length)
  assert.equal(events.filter(row=>row.route==='gap').length,5)
  for(const id of['F1','F2-fit','F3','F5','F6-turns','F7','timer-restart','cutoff-skip','eliminated-both','notification-timeliness','notification-duplicates','webkit'])assert.ok(find(id))
})

test('early green samples cannot close the full run or a two-season feature',()=>{
  const observed={run:{liveSamples:1,realtime:{passed:true},fullAcceptance:false},exports:[{file:'F1-2025-week-1.json',status:'PASS',passed:true}]}
  assert.equal(criterionStatus(find('F1'),observed),'PARTIAL')
  assert.equal(criterionStatus(find('live-streams'),observed),'PARTIAL')
  observed.exports[0].status='FAILED'
  assert.equal(criterionStatus(find('F1'),observed),'FAILED')
  assert.notEqual(criterionStatus(find('fresh-run'),observed),'PASS')
})

test('external mappings and unavailable browsers are never silently promoted to green',()=>{
  const observed={run:{fullAcceptance:true},exports:[]}
  assert.equal(criterionStatus(find('native-safari'),observed),'GAP')
  assert.equal(criterionStatus(find('audit'),observed),'FAILED')
  assert.notEqual(criterionStatus(find('timer-restart'),observed),'PASS')
  const proof={criteria:['timer-restart'],sourceManifestSha256:'pinned',commands:[{exit:0},{exit:0}]}
  assert.equal(criterionStatus(find('timer-restart'),observed,[],[proof]),'LANE EVIDENCE')
  assert.notEqual(criterionStatus(find('timer-restart'),observed,[],[{...proof,commands:[{exit:1},{exit:0}]}]),'LANE EVIDENCE')
  assert.equal(criterionStatus(find('skip-expiry'),observed,[{id:'skip-expiry',passed:true}]),'PARTIAL')
  assert.equal(criterionStatus(find('skip-expiry'),observed,[{id:'skip-expiry',passed:true},{id:'skip-expiry',passed:true}]),'PASS')
  assert.equal(criterionStatus(find('skip-expiry'),observed,[{id:'skip-expiry',passed:false}]),'FAILED')
})

test('ETA uses measured samples, labels its model and refuses a stopped replay forecast',()=>{
  const run={phase:'2024-10-22:morning',days:[{date:'2024-10-21',wallSeconds:100}]},row={expected:[{date:'2024-10-23'}]}
  assert.equal(estimateCriterion(row,run,0).at,'1970-01-01T00:03:20.000Z')
  assert.match(estimateCriterion(row,run,0).model,/unmeasured idle/)
  assert.equal(estimateCriterion(row,{...run,failure:{message:'failed'}},0).at,null)
  assert.equal(estimateCriterion(row,{...run,days:[]},0).at,null)
  const recorded={...run,failures:[{message:'nonfatal observed failure'}]}
  assert.ok(estimateCriterion(row,recorded,0).at)
  assert.match(estimateCriterion(row,recorded,0).model,/acceptance already has failures/)
  assert.equal(criterionStatus(find('fresh-run'),{run:recorded,exports:[]}), 'FAILED')
  assert.equal(summarizeProgress({run,exports:[]},{now:0}).criteria.length,criteria.length)
})

test('read-only collection ignores transport logs and never modifies observed files',async()=>{
  const input=await mkdtemp(path.join(tmpdir(),'sim-progress-read-'))
  await writeFile(path.join(input,'replay-checkpoint.json'),JSON.stringify({days:[],phase:'startup',fullAcceptance:true}))
  await writeFile(path.join(input,'expo-transport.jsonl'),'not a JSON export')
  const before=await readFile(path.join(input,'replay-checkpoint.json'),'utf8')
  const result=await readProgress(input)
  assert.equal(result.run.fullAcceptance,false)
  assert.equal(await readFile(path.join(input,'replay-checkpoint.json'),'utf8'),before)
  assert.deepEqual(result.errors,[])
})

test('output guards reject observed directories and symlink escapes before writing',async()=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'sim-progress-output-'))),input=path.join(root,'observed'),output=path.join(root,'own')
  await mkdir(input);await mkdir(output)
  assert.equal(await assertOutput(input,output,output),output)
  await assert.rejects(()=>assertOutput(input,input,output))
  const linked=path.join(output,'escape');await symlink(input,linked)
  await assert.rejects(()=>assertOutput(input,path.join(linked,'new'),output))
})
