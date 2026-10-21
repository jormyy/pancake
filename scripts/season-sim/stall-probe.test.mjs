import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import { createStallProbe,boundedProbeAppender } from './stall-probe.mjs'

function fixture(options={}){
  let at=0,onWrite=()=>{}
  const records=[]
  const written=new Promise(resolve=>{onWrite=()=>resolve(null)})
  const probe=createStallProbe({now:()=>at,read:async()=>({edge:{active:1,fetches:0,sleeping:1,nextAt:20000,at:'2024-11-05T00:13:20Z'},database:{activity:[],locks:[]},host:{uptime:'load averages: 1 1 1',vm_stat:'Pages free: 100'}}),append:async line=>{records.push(JSON.parse(line));onWrite()},...options})
  return {probe,records,written,at:value=>{at=value}}
}

test('a production dispatch triggers once after ten real seconds, across clock settles',async()=>{
  const f=fixture()
  f.probe.watch([{id:2921,function_name:'live-poll'}])
  f.at(10000);await f.probe.check();assert.equal(f.records.length,0)
  f.probe.watch([{id:2921,function_name:'live-poll'}])
  f.at(10001);await f.probe.check();assert.equal(f.records.length,1)
  assert.equal(f.records[0].pending[0].elapsedMs,10001)
  assert.equal(f.records[0].edge.nextAt,20000)
  f.at(30000);await f.probe.check();assert.equal(f.records.length,1)
  await f.probe.close()
})

test('the native watchdog records while the dispatcher is waiting on another operation',async()=>{
  const f=fixture()
  f.probe.watch([{id:1}]);f.at(10001)
  let timeout
  try{await Promise.race([f.written,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Native watchdog did not run')),1000)})])}
  finally{clearTimeout(timeout)}
  assert.equal(f.records.length,1)
  f.probe.finish(1);await f.probe.check();assert.equal(f.records.length,1)
  await f.probe.close()
})

test('finished requests do not trigger and the record count stays bounded',async()=>{
  const f=fixture({maximumRecords:2})
  f.probe.watch([{id:1}]);f.probe.finish(1);f.at(11000);await f.probe.check()
  assert.equal(f.records.length,0)
  for(let id=2;id<7;id++){
    f.probe.watch([{id}]);f.at(id*20000);await f.probe.check();f.probe.finish(id)
  }
  assert.equal(f.records.length,2)
  await f.probe.close()
})

test('probe snapshots have a byte bound and exclude SQL text, credentials and request headers',async()=>{
  const f=fixture({maximumBytes:2048,read:async()=>({password:'secret-value',edge:{active:100,requests:Array.from({length:100},()=>({function:'live-poll',headers:{authorization:'secret-value'},waits:[{kind:'fetch',target:'http://user:secret-value@localhost/?token=secret-value'}]}))},database:{activity:Array.from({length:100},(_,pid)=>({pid,state:'active',query:'SELECT secret-value',blocking_pids:[1,2]})),locks:Array.from({length:200},(_,pid)=>({pid,mode:'RowExclusiveLock',granted:true}))},host:{uptime:'x'.repeat(10000),vm_stat:'x'.repeat(10000)}})})
  f.probe.watch([{id:1}]);f.at(10001);await f.probe.check()
  const json=JSON.stringify(f.records[0])
  assert.ok(Buffer.byteLength(json+'\n')<=2048)
  assert.ok(!json.includes('secret-value'))
  assert.equal(f.records[0].truncated,true)
  await f.probe.close()
})

test('a hung or failed diagnostic cannot hang the replay or turn a failed worker green',async()=>{
  const f=fixture({timeoutMs:20,read:()=>new Promise(()=>{})})
  f.probe.watch([{id:1}]);f.at(10001);await f.probe.check()
  assert.equal(f.records[0].error.name,'TimeoutError')
  await f.probe.close()
  const broken=fixture({read:async()=>{throw new Error('secret-value')},append:async()=>{throw new Error('secret-value')}})
  broken.probe.watch([{id:2}]);broken.at(10001)
  await assert.doesNotReject(broken.probe.check())
  await broken.probe.close()
})

test('a stuck evidence write has a real-time bound',async()=>{
  const f=fixture({append:()=>new Promise(()=>{})})
  f.probe.watch([{id:1}]);f.at(10001)
  let timer
  const completed=await Promise.race([f.probe.check().then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),300)})])
  clearTimeout(timer)
  assert.equal(completed,true)
  await f.probe.close()
})

test('the shared output file has a byte cap, including existing data and concurrent probes',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'stall-probe-'))
  try{
    const file=path.join(directory,'probes.jsonl')
    await writeFile(file,'SYNTHETIC unit\n')
    const append=boundedProbeAppender(file,30)
    await Promise.all([append('1234567890\n'),append('abcdefghij\n'),append('excess\n')])
    const bytes=await readFile(file)
    assert.ok(bytes.length<=30)
    assert.equal(bytes.toString(),'SYNTHETIC unit\n1234567890\n')
  }finally{await rm(directory,{recursive:true,force:true})}
})
