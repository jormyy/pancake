import{readFile,writeFile}from'node:fs/promises'
import path from'node:path'
import{miniRoot,assertTarget,writeJson}from'./common.mjs'
import{sqlJson}from'./local-stack.mjs'
import{checkDraftPushes}from'./feature-oracles.mjs'

export async function registerPushOwners(c,keys){
  assertTarget(keys.API_URL,'api')
  c.pushOwners=[]
  c.outsidePush=null
  c.pushRegistration={status:'SKIPPED',reason:'Device delivery evidence requires the web push transport; Expo signup is removed.'}
  return c.pushRegistration
}

export async function captureDraftPushes(c,draftId,report){
  const input=await sqlJson(`SELECT json_build_object('picks',(SELECT json_agg(p ORDER BY overall_pick) FROM snake_draft_picks p WHERE draft_id='${draftId}'),'audits',(SELECT coalesce(json_agg(a),'[]') FROM draft_audit_logs a WHERE draft_id='${draftId}'),'outbox',(SELECT coalesce(json_agg(o),'[]') FROM notification_outbox o WHERE data->>'draftId'='${draftId}'))`,'F6 per-pick notification export')
  const text=await readFile(path.join(miniRoot,'evidence/expo-transport.jsonl'),'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return''})
  const deliveries=text.split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.kind==='push')
  let result
  if(c.pushRegistration?.status==='SKIPPED')result={...c.pushRegistration,error:null,table:null}
  else try{result={status:'PASS',error:null,...checkDraftPushes(input.picks,c.pushOwners,deliveries,input.outbox,input.audits)}}catch(error){result={status:'FAILED',error:error.message,table:null}}
  if(result.status==='FAILED'){report.failures??=[];report.failures.push({name:'AssertionError',area:'notifications',message:result.error,phase:'rookie-draft-pushes'})}
  report.draftPushes=result
  await writeJson(path.join(miniRoot,'evidence/F6-rookie-picks.json'),{...input,owners:c.pushOwners,outside:c.outsidePush,deliveries:deliveries.filter(row=>row.data?.draftId===draftId),...result})
  await writeFile(path.join(miniRoot,'evidence/F6-rookie-picks.md'),`# Rookie on-clock pushes\n\n${result.status}: ${result.error??result.reason??'Each pick delivers exactly once to its owner'}\n\n\`\`\`json\n${JSON.stringify(result.table??input.picks,null,2)}\n\`\`\`\n`)
  console.log(`F6 rookie pushes: ${result.status}${result.error?' '+result.error:''}`)
  return result
}
