import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { createLivePoller, fetchLiveSnapshot, readLiveSnapshot, overlayLiveScores, nextLiveRecovery, decodeSavedLiveView } from '@pancake/core'
import { id, loopback } from './common.mjs'
import { userToken } from './quality.mjs'
import { scoreMessage } from './quality-grade.mjs'
import { advancePhoneVersion, phoneChange } from './phone-read.mjs'
import { readWireResponse } from './wire.mjs'

export async function startPhones(stack, publicFeed) {
  loopback(stack.api,[stack.ports.api])
  const phones = []
  const date = await stack.sql("SELECT (now() AT TIME ZONE 'America/New_York')::date")
  const requests = [], renders = [], reads = [], messages = [], frames = [], refreshes = []
  const faults = new Set(stack.qualityOptions?.fault?.split(',') ?? [])
  let closed = false
  const createPhone = async index => {
    const token = userToken(stack,id(100+index))
    const client = createClient(stack.api,stack.keys.ANON_KEY,{auth:{autoRefreshToken:false,persistSession:false}})
    await client.realtime.setAuth(token)
    const phone = { index, client, view:null, snapshot:null, visible:true, online:true, ready:false, pending:false,
      loading:null, poller:null, channel:null, error:null, broadcasts:0, timer:null,recoveryTimer:null,recoveryKey:'',version:'0' }
    phones.push(phone)
    const render = () => {
      if (!phone.view || closed) return
      const start = performance.now()
      const settings = phone.view.context?.league?.scoring_settings ?? {}
      const score = overlayLiveScores(phone.view.liveBasis ?? [],phone.snapshot,settings,Date.now())
      const selected = score.matchups.find(row=>row.id===phone.view.matchup?.id)
      phone.display = { at:Date.now(),matchupId:phone.view.matchup?.id,
        homePoints:selected?.homePoints ?? Number(phone.view.matchup?.myPoints ?? 0),
        awayPoints:selected?.awayPoints ?? Number(phone.view.matchup?.opponentPoints ?? 0),
        homeMemberId:selected?.homeMemberId ?? phone.view.matchup?.myMemberId,
        awayMemberId:selected?.awayMemberId ?? phone.view.matchup?.opponentMemberId,
        stale:selected?.stale ?? false,mode:phone.snapshot?.mode ?? 'database' }
      if(index===1 && faults.has('phone-final'))phone.display.homePoints++
      renders.push({phone:index,...phone.display,calculationMs:performance.now()-start})
    }
    const scheduleRecovery = () => {
      clearTimeout(phone.recoveryTimer)
      if(closed || !phone.visible || !phone.online)return
      const delay=nextLiveRecovery(phone.view?.todaysGames ?? [],Date.now(),phone.snapshot?.mode==='public')
      if(delay===null)return
      phone.recoveryTimer=setTimeout(async()=>{
        const at=Date.now()
        try {
          const version=encodeURIComponent(phone.version)
          const response=await readWireResponse(`http://127.0.0.1:${stack.ports.edge}/functions/v1/api/version?league=${id(1)}&since=${version}`,{authorization:`Bearer ${token}`})
          const body=response.body
          reads.push({kind:'version',phone:index,at,done:Date.now(),status:response.status,bytes:response.bytes,wireBytes:response.wireBytes,encoding:response.encoding})
          assert.ok(response.ok,`Phone ${index} cannot check its screen version`)
          const value=JSON.parse(body)
          if(BigInt(value.version)>BigInt(phone.version)) {
            phone.version=advancePhoneVersion(phone.version,value.version)
            phone.readReason='recovery'
            await phone.refresh()
          }
        } catch(error) {phone.error=error.message}
        finally {scheduleRecovery()}
      },delay)
    }
    const updateRecovery = () => {
      const key=JSON.stringify([phone.visible,phone.online,phone.snapshot?.mode,phone.view?.todaysGames?.map(game=>[game.id,game.status,game.game_time])])
      if(key===phone.recoveryKey)return
      phone.recoveryKey=key
      scheduleRecovery()
    }
    phone.poller = createLivePoller({
      load: async(day,signal)=>{
        const at=Date.now()
        try {
          const result=await fetchLiveSnapshot(`${publicFeed.origin}/api/live/${day}`,signal)
          const snapshot=readLiveSnapshot(result.body,day,Date.now())
          if(index===1 && faults.has('phone-stale') && snapshot)result.body={...snapshot,capturedAt:Date.now()-120001}
          requests.push({phone:index,at,done:Date.now(),cache:result.cache,sourceAt:snapshot?.capturedAt,mode:snapshot?.mode})
          return result
        } catch(error) { requests.push({phone:index,at,done:Date.now(),error:error.message});throw error }
      },
      onSnapshot:snapshot=>{phone.snapshot=snapshot;if(snapshot)frames.push({phone:index,at:Date.now(),snapshot});render();updateRecovery()},
    })
    const updatePoll = () => phone.poller.update({ date,active:Boolean(phone.view?.todaysGames?.some(game=>game.status==='InProgress')),
      visible:phone.visible,online:phone.online })
    phone.activity = (visible,online) => {phone.visible=visible;phone.online=online;updatePoll();updateRecovery()}
    phone.refresh = () => {
      if (closed || !phone.visible || !phone.online) return Promise.resolve()
      if (phone.loading) {phone.pending=true;return phone.loading}
      phone.loading=(async()=>{
        do {
          phone.pending=false
          const at=Date.now()
          const query=new URLSearchParams({leagueId:id(1),memberId:id(200+index),params:JSON.stringify({date}),compact:'1'})
          const response=await readWireResponse(`http://127.0.0.1:${stack.ports.edge}/functions/v1/api/views/home?${query}`,{authorization:`Bearer ${token}`})
          const body=response.body
          reads.push({kind:'home',reason:phone.readReason ?? 'open',phone:index,at,done:Date.now(),status:response.status,bytes:response.bytes,wireBytes:response.wireBytes,encoding:response.encoding,
            fields:Object.fromEntries(Object.entries(JSON.parse(body).view ?? {}).map(([name,value])=>[name,Buffer.byteLength(JSON.stringify(value))]))})
          assert.ok(response.ok,`Phone ${index} cannot read its authorized home (${response.status})`)
          const result=JSON.parse(body)
          assert.ok(result.ok && result.view,`Phone ${index} received an invalid screen response`)
          phone.view=decodeSavedLiveView(result.view)
          phone.version=advancePhoneVersion(phone.version,phone.view.context?.version)
          phone.ready=true
          render();updatePoll();updateRecovery()
        } while(phone.pending && !closed)
      })().catch(error=>{phone.error=error.message}).finally(()=>{phone.loading=null})
      return phone.loading
    }
    phone.channel=client.channel(`l1:league:${id(1)}`,{config:{private:true}}).on('broadcast',{event:'change'},message=>{
      const score=scoreMessage(message)
      messages.push({phone:index,at:Date.now(),bytes:Buffer.byteLength(JSON.stringify(message)),score,
        table:message.payload?.table,hints:message.payload?.hints?.map(hint=>({event:hint.event,table:hint.payload?.table,topic:hint.row?.topic,updatedAt:hint.row?.updated_at,scopes:hint.row?.scopes,details:hint.row?.details}))})
      if(score)phone.broadcasts++
      const change=phoneChange(message,id(1),phone.version,{seasonId:phone.view?.context?.seasonId,date:phone.view?.selectedDate,
        week:phone.view?.context?.weekNumber,memberIds:[phone.view?.matchup?.myMemberId,phone.view?.matchup?.opponentMemberId].filter(Boolean)})
      phone.version=advancePhoneVersion(phone.version,change.version)
      if(change.refresh && !(index===1 && faults.has('phone-refresh'))){
        phone.readReason='broadcast:'+(message.payload?.hints?.map(hint=>hint.row?.topic ?? hint.payload?.table).filter(Boolean).join(',') ?? message.payload?.table ?? 'change')
        clearTimeout(phone.timer)
        phone.timer=setTimeout(async()=>{
          if(closed || !phone.visible || !phone.online)return
          await phone.refresh()
          if(!phone.error)refreshes.push({phone:index,at:Date.now()})
        },200)
      }
    })
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`Phone ${index} Realtime subscription times out`)),15000)
      phone.channel.subscribe(status=>{
        if(status==='SUBSCRIBED'){clearTimeout(timer);resolve()}
        if(['CHANNEL_ERROR','TIMED_OUT'].includes(status)){clearTimeout(timer);reject(new Error(`Phone ${index} Realtime ${status}`))}
      })
    })
    phone.topics=[`l1:league:${id(1)}`,`l1:member:${id(200+index)}`,`l1:user:${id(100+index)}`]
    for(const topic of phone.topics.slice(1)) {
      const channel=client.channel(topic,{config:{private:true}}).on('broadcast',{event:'change'},message=>{
        messages.push({phone:index,at:Date.now(),bytes:Buffer.byteLength(JSON.stringify(message)),score:scoreMessage(message),
          topic,table:message.payload?.table})
      })
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error(`Phone ${index} personal subscription times out`)),15000)
        channel.subscribe(status=>{
          if(status==='SUBSCRIBED'){clearTimeout(timer);resolve()}
          if(['CHANNEL_ERROR','TIMED_OUT'].includes(status)){clearTimeout(timer);reject(new Error(`Phone ${index} personal Realtime ${status}`))}
        })
      })
    }
    await phone.refresh()
    assert.ok(phone.ready && !phone.error,`Phone ${index} cannot open its home: ${phone.error}`)
  }
  const close = async () => {
    if(closed)return
    closed=true
    for(const phone of phones){clearTimeout(phone.timer);clearTimeout(phone.recoveryTimer);phone.poller?.dispose()}
    await Promise.allSettled(phones.map(async phone=>{await phone.loading;await phone.client.removeAllChannels()}))
  }
  try {
    for(let index=1;index<=10;index++)await createPhone(index)
    return { phones,requests,renders,reads,messages,frames,refreshes,close,refresh:()=>Promise.all(phones.map(phone=>phone.refresh())),
      snapshot:()=>phones.map(phone=>({phone:phone.index,ready:phone.ready,error:phone.error,broadcasts:phone.broadcasts,topics:phone.topics,display:phone.display})) }
  } catch(error){await close();throw error}
}
