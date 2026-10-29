import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { connectionEnvironment } from '../../scripts/db-health/index.mjs'

test('concurrent receipt identities stay unique across months',{skip:!process.env.PARTITION_DB_TESTS},async()=>{
const env=connectionEnvironment(process.env.SUPABASE_DB_URL)
const args=['-XqAt','-v','ON_ERROR_STOP=1']
const run=sql=>{
  const result=spawnSync('psql',args,{env,input:sql,encoding:'utf8',timeout:10000})
  assert.equal(result.status,0,result.stderr)
  return result.stdout.trim()
}
const key=randomUUID()
const held=spawn('psql',args,{env,stdio:['pipe','pipe','pipe']})
let errors=''
held.stderr.on('data',chunk=>{errors+=chunk})
const marker=randomUUID()
const ready=new Promise((resolve,reject)=>{
  let output=''
  held.stdout.on('data',chunk=>{output+=chunk;if(output.includes(marker))resolve()})
  held.on('exit',code=>{if(code)reject(new Error(errors))})
})
let second
try{
  run("SELECT private.ensure_log_partition('private.request_receipts',(now()-interval '1 month')::date)")
  held.stdin.write(`BEGIN; INSERT INTO private.request_receipts VALUES('${key}','${key}','concurrent','{}',date_trunc('month',now()),'same');\n\\echo ${marker}\n`)
  await ready
  second=spawn('psql',args,{env,stdio:['pipe','pipe','pipe']})
  let secondError='',settled=false
  second.stderr.on('data',chunk=>{secondError+=chunk})
  const result=new Promise(resolve=>second.on('exit',code=>{settled=true;resolve(code)}))
  second.stdin.end(`INSERT INTO private.request_receipts VALUES('${key}','${key}','concurrent','{}',date_trunc('month',now())-interval '1 month','same');`)
  await new Promise(resolve=>setTimeout(resolve,100))
  if(!process.env.PARTITION_EXPECT_BROKEN)assert.equal(settled,false,'The second identity waits for the first transaction')
  const firstDone=new Promise(resolve=>held.once('exit',resolve))
  held.stdin.end('COMMIT;\n')
  const code=await result
  await firstDone
  if(process.env.PARTITION_EXPECT_BROKEN){assert.equal(code,0,secondError);assert.equal(run(`SELECT count(*) FROM private.request_receipts WHERE request_id='${key}'`),'2')}
  else{assert.notEqual(code,0);assert.match(secondError,/Duplicate partitioned identity/);assert.equal(run(`SELECT count(*) FROM private.request_receipts WHERE request_id='${key}'`),'1')}
  console.log('Cross-month concurrent identity check passed')
}finally{
  held.kill('SIGTERM')
  second?.kill('SIGTERM')
  run(`DELETE FROM private.request_receipts WHERE request_id='${key}'`)
}

})
