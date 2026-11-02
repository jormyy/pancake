import { computeForecast } from './compute.ts'
import type { ForecastContext } from './compute.ts'

export type ForecastClaim = {matchup_id:string;revision:number;claim_token:string}
export type ForecastWrite = ForecastClaim & {forecast:ReturnType<typeof computeForecast>;validUntil:string}
export type ForecastReceipt = {matchupId:string;saved:boolean;error?:string}

export async function runForecastWork(dependencies: {
  claim:()=>Promise<ForecastClaim[]>
  context:(id:string)=>Promise<ForecastContext>
  publish:(items:ForecastWrite[])=>Promise<ForecastReceipt[]>
  fail:(claim:ForecastClaim,message:string)=>Promise<void>
}) {
  let completed=0
  const failures:string[]=[],pending:ForecastWrite[]=[]
  const failed=async(claim:ForecastClaim,error:unknown)=>{
    const message=error instanceof Error?error.message:JSON.stringify(error)
    failures.push(`${claim.matchup_id}: ${message}`)
    try {await dependencies.fail(claim,message)}
    catch(error) {failures.push(error instanceof Error?error.message:JSON.stringify(error))}
  }
  for(const claim of await dependencies.claim()) {
    try {
      const input=await dependencies.context(claim.matchup_id)
      const now=Date.parse(input.observedAt)
      const next=input.games.map(game=>Date.parse(game.game_time??'')).filter(time=>time>now).sort((a,b)=>a-b)[0]
      pending.push({...claim,forecast:computeForecast(input),validUntil:new Date(Math.min(now+21600000,next??Infinity)).toISOString()})
    } catch(error) {await failed(claim,error)}
  }
  const publish=async(items:ForecastWrite[])=>{
    try {
      const results=await dependencies.publish(items)
      const ids=new Set(items.map(item=>item.matchup_id))
      if(!Array.isArray(results) || results.length!==items.length || new Set(results.map(row=>row.matchupId)).size!==items.length
        || results.some(row=>!ids.has(row.matchupId) || typeof row.saved!=='boolean'))throw new Error('Forecast receipts do not match their claims')
      for(const item of items) {
        const receipt=results.find(row=>row.matchupId===item.matchup_id)!
        if(receipt.error)await failed(item,receipt.error)
        else if(receipt.saved)completed++
      }
    } catch(error) {for(const item of items)await failed(item,error)}
  }
  if(pending.length)await publish(pending)
  return {completed,failures}
}
