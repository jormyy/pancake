import assert from 'node:assert/strict'
import {randomUUID}from'node:crypto'
import { readFile } from 'node:fs/promises'
import { appendFile } from '../perf-lab/bounded-log.mjs'
import path from 'node:path'

export async function fakeExpoRecorder(directory,now,lookup){
  const file=path.join(directory,'expo-transport.jsonl')
  const old=await readFile(file,'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return''})
  const tickets=new Map(old.split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.kind==='push').map(row=>[row.ticketId,row]))
  return async(route,body)=>{
    assert.ok(['/push','/receipts'].includes(route))
    const businessAt=new Date(now()).toISOString()
    if(route==='/push'){
      const messages=Array.isArray(body)?body:[body],data=[]
      for(const message of messages){
        assert.match(message.to,/^ExponentPushToken\[season-sim-[a-zA-Z0-9-]+\]$/,'Only synthetic replay push tokens reach the fake transport')
        const matches=await lookup(message.to,message.data??{},message.data?.outboxId)
        const ticketId=randomUUID(),row={kind:'push',provenance:'SYNTHETIC fake Expo transport',businessAt,recipientToken:message.to,eventType:message.data?.notificationEvent??null,dedupeKey:matches.length===1?matches[0].dedupe_key:null,dedupeCandidates:matches.map(row=>row.dedupe_key),ticketId,data:message.data??{}}
        tickets.set(ticketId,row)
        await appendFile(file,JSON.stringify(row)+'\n')
        data.push({status:'ok',id:ticketId})
      }
      return{data:Array.isArray(body)?data:data[0]}
    }
    assert.ok(Array.isArray(body.ids))
    for(const id of body.ids)assert.ok(tickets.has(id),'Receipts only acknowledge tickets recorded by this fake origin')
    await appendFile(file,JSON.stringify({kind:'receipts',provenance:'SYNTHETIC fake Expo receipts',businessAt,ids:body.ids,messages:body.ids.map(id=>({ticketId:id,recipientToken:tickets.get(id).recipientToken,eventType:tickets.get(id).eventType,dedupeKey:tickets.get(id).dedupeKey}))})+'\n')
    return{data:Object.fromEntries(body.ids.map(id=>[id,{status:'ok'}]))}
  }
}
