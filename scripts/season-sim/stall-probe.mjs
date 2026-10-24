import { execFile } from 'node:child_process'
import { appendFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { assertTarget, miniRoot, originUrl } from './common.mjs'
import { databaseEnvironment } from './local-stack.mjs'

const execute=promisify(execFile)
export function boundedProbeAppender(file,maximumBytes=4194304){
  let initialization,bytes
  return async line=>{
    initialization??=stat(file).then(row=>{bytes=row.size},error=>{if(error.code!=='ENOENT')throw error;bytes=0})
    await initialization
    const size=Buffer.byteLength(line)
    if(bytes+size>maximumBytes)return
    bytes+=size
    await appendFile(file,line)
  }
}
const appendProbe=boundedProbeAppender(path.join(miniRoot,'evidence/stall-probes.jsonl'))
const diagnosticSql=`BEGIN READ ONLY;
SET LOCAL statement_timeout='1000ms';
SET LOCAL lock_timeout='500ms';
SELECT json_build_object('at',clock_timestamp(),'queue',(SELECT coalesce(json_agg(r),'[]') FROM (SELECT id FROM net.http_request_queue ORDER BY id LIMIT 32) r),'invocations',(SELECT coalesce(json_agg(r),'[]') FROM (SELECT id,request_id,function_name,worker_status,queued_at,worker_started_at,worker_finished_at FROM edge_invocations ORDER BY id DESC LIMIT 32) r),'activity',(SELECT coalesce(json_agg(r),'[]') FROM (
  SELECT pid,backend_type,state,wait_event_type,wait_event,query_start,xact_start,pg_blocking_pids(pid) AS blocking_pids
  FROM pg_stat_activity WHERE datname=current_database() ORDER BY pid LIMIT 32
) r),'locks',(SELECT coalesce(json_agg(r),'[]') FROM (
  SELECT pid,locktype,database,relation,mode,granted,waitstart
  FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database())
    OR pid IN (SELECT pid FROM pg_stat_activity WHERE datname=current_database())
  ORDER BY granted,pid,locktype LIMIT 64
) r));
COMMIT;`

function errorFields(error){
  return {name:['TimeoutError','AbortError'].includes(error?.name)?error.name:'Error',timedOut:error?.killed===true}
}

async function collectStall(){
  const attempt=async operation=>{try{return await operation()}catch(error){return{error:errorFields(error)}}}
  const [edge,database,uptime,vmStat]=await Promise.all([
    attempt(async()=>{
      const response=await fetch(`${originUrl('edge')}/health`,{redirect:'error',signal:AbortSignal.timeout(1000)})
      if(!response.ok)throw new Error('Health read fails')
      return response.json()
    }),
    attempt(async()=>{
      const target=assertTarget(process.env.SUPABASE_DB_URL,'db')
      const {stdout}=await execute(path.resolve(miniRoot,'../../tools/pg/bin/psql'),['-XqAt','--set','ON_ERROR_STOP=1','-c',diagnosticSql],{env:databaseEnvironment(target),timeout:1500,maxBuffer:32768})
      return JSON.parse(stdout.trim())
    }),
    attempt(async()=>(await execute('uptime',[],{timeout:1000,maxBuffer:4096})).stdout),
    attempt(async()=>(await execute('vm_stat',[],{timeout:1000,maxBuffer:8192})).stdout),
  ])
  return {edge,database,host:{uptime,vm_stat:vmStat}}
}

function fields(row,keys){
  return Object.fromEntries(keys.filter(key=>row?.[key]!=null).map(key=>[key,typeof row[key]==='string'?row[key].slice(0,128):row[key]]))
}

function snapshotFields(snapshot){
  const edge=snapshot.edge??{},database=snapshot.database??{},host=snapshot.host??{}
  return {
    edge:{...fields(edge,['active','fetches','sleeping','nextAt','at','error']),requests:(edge.requests??[]).slice(0,32).map(row=>({
      ...fields(row,['id','function','invocation','elapsedMs']),
      waits:(row.waits??[]).slice(0,16).map(wait=>({kind:String(wait.kind).slice(0,40),...fields(wait,['due','repeat','ms']),...(typeof wait.target==='string'&&/^\/(?:rest\/v1\/\w+|functions\/v1\/[\w-]+|__sim\/live-sample)$/.test(wait.target)?{target:wait.target}:{})})),
    }))},
    database:{...fields(database,['at','error']),queue:(database.queue??[]).slice(0,32).map(row=>fields(row,['id'])),invocations:(database.invocations??[]).slice(0,32).map(row=>fields(row,['id','request_id','function_name','worker_status','queued_at','worker_started_at','worker_finished_at'])),activity:(database.activity??[]).slice(0,32).map(row=>({...fields(row,['pid','backend_type','state','wait_event_type','wait_event','query_start','xact_start']),blocking_pids:(row.blocking_pids??[]).slice(0,8)})),locks:(database.locks??[]).slice(0,64).map(row=>fields(row,['pid','locktype','database','relation','mode','granted','waitstart']))},
    host:{uptime:typeof host.uptime==='string'?host.uptime.slice(0,1024):host.uptime,vm_stat:typeof host.vm_stat==='string'?host.vm_stat.slice(0,4096):host.vm_stat},
  }
}

function boundedRecord(record,maximumBytes){
  let line=JSON.stringify(record)+'\n'
  if(Buffer.byteLength(line)<=maximumBytes)return line
  record.truncated=true
  record.edge={...record.edge,requests:[]}
  record.database={...record.database,activity:[],locks:[],queue:[],invocations:[]}
  record.host={}
  line=JSON.stringify(record)+'\n'
  while(Buffer.byteLength(line)>maximumBytes&&record.pending.length>1){record.pending.pop();line=JSON.stringify(record)+'\n'}
  return line
}

export function createStallProbe({now=Date.now,read=collectStall,append=appendProbe,interval=setInterval,clear=clearInterval,thresholdMs=10000,maximumRecords=128,maximumBytes=32768,timeoutMs=2000}={}){
  const pending=new Map()
  let timer,busy=null,records=0
  const stopTimer=()=>{if(timer!=null){clear(timer);timer=null}}
  const check=()=>{
    if(busy)return busy
    const overdue=[...pending.values()].filter(row=>!row.sampled&&now()-row.started>thresholdMs).slice(0,32)
    if(!overdue.length||records>=maximumRecords)return Promise.resolve()
    records++
    for(const row of overdue)row.sampled=true
    const observed=now()
    const record={kind:'production-dispatch-stall',realAt:new Date(observed).toISOString(),thresholdMs,pending:overdue.map(row=>({id:row.id,function:row.function,elapsedMs:observed-row.started})),truncated:false}
    busy=(async()=>{
      let timeout
      try{
        const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Object.assign(new Error('Probe budget'),{name:'TimeoutError'})),timeoutMs)})
        Object.assign(record,snapshotFields(await Promise.race([Promise.resolve().then(read),deadline])))
      }catch(error){record.error=errorFields(error)}
      finally{clearTimeout(timeout)}
      let writeTimeout
      try{await Promise.race([append(boundedRecord(record,maximumBytes)),new Promise(resolve=>{writeTimeout=setTimeout(resolve,100)})])}catch{}
      finally{clearTimeout(writeTimeout)}
    })().finally(()=>{busy=null})
    return busy
  }
  const watch=rows=>{
    for(const row of rows){
      const entry=pending.get(row.id)??{id:row.id,function:null,started:now(),sampled:false}
      entry.function=row.function_name??entry.function
      pending.set(row.id,entry)
    }
    if(pending.size&&timer==null){timer=interval(check,250);timer?.unref?.()}
  }
  const finish=id=>{pending.delete(id);if(!pending.size)stopTimer()}
  return {watch,finish,check,async close(){stopTimer();pending.clear();await busy}}
}
