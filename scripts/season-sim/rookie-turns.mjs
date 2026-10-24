import assert from'node:assert/strict'
import{sql}from'./local-stack.mjs'
import{expiryCronTick}from'./cron.mjs'

export function nextNotificationWindow(at){
  const dispatch=(Math.floor(at/300000)+1)*300000
  return {resume:dispatch-15000,dispatch}
}

export async function playRookieTurns(c,draftId,move,report,{firstExpiry='auto_pick'}={}){
  const now=async()=>Number(await sql('SELECT extract(epoch FROM now())*1000'))
  const original=JSON.parse(await sql(`SELECT json_agg(p ORDER BY overall_pick) FROM snake_draft_picks p WHERE draft_id='${draftId}'`))
  report.rookiePause=[]
  for(const pick of original){
    const current=JSON.parse(await sql(`SELECT row_to_json(p) FROM snake_draft_picks p WHERE id='${pick.id}'`))
    assert.ok(!current.picked_at&&!current.skipped_at,'Every expected pick becomes the current on-clock pick')
    await c.api(c.users[0],`/draft/${draftId}/pause`,{})
    const paused=JSON.parse(await sql(`SELECT row_to_json(d) FROM drafts d WHERE id='${draftId}'`))
    let window=nextNotificationWindow(await now())
    if(window.resume<await now())window=nextNotificationWindow(window.dispatch)
    await move(window.resume)
    await c.api(c.users[0],`/draft/${draftId}/resume`,{})
    const resumed=JSON.parse(await sql(`SELECT row_to_json(p) FROM snake_draft_picks p WHERE id='${pick.id}'`))
    assert.equal(Date.parse(resumed.timer_expires_at)-await now(),Number(paused.timer_paused_remaining_seconds)*1000,'Pause/resume preserves the remaining pick seconds')
    report.rookiePause.push({pick:pick.overall_pick,remainingSeconds:paused.timer_paused_remaining_seconds,passed:true})
    await move(window.dispatch)
    if(pick.overall_pick===1){
      await move(expiryCronTick(resumed.timer_expires_at))
      const expired=JSON.parse(await sql(`SELECT row_to_json(p) FROM snake_draft_picks p WHERE id='${pick.id}'`))
      if(firstExpiry==='skip_pick')assert.ok(expired.skipped_at&&!expired.player_id,'The production expiry gate skips the first pick')
      else assert.ok(expired.player_id&&expired.picked_at,'The production expiry gate auto-picks the first pick')
      report.rookieAutoPick={draftId,pick:expired,timerSeconds:60,passed:firstExpiry==='auto_pick'}
      continue
    }
    const user=c.users.find(user=>user.memberId===pick.member_id)
    const playerId=await sql(`SELECT id FROM players WHERE ${process.env.SEASON_SIM_MODE==='two-season'?'nba_draft_number IS NOT NULL AND years_exp=0':`display_name LIKE 'Synthetic Prospect ${c.seasonYear-1} %'`} AND NOT EXISTS(SELECT 1 FROM roster_players r WHERE r.league_id='${c.leagueId}' AND r.player_id=players.id) ORDER BY nba_draft_number,id LIMIT 1`)
    assert.ok(playerId)
    await c.api(user,`/draft/${draftId}/snake-pick`,{memberId:user.memberId,playerId,toTaxi:true})
  }
  assert.equal(await sql(`SELECT status FROM drafts WHERE id='${draftId}'`),'completed')
  if(c.pushOwners){
    const began=await now(),deadline=began+70*60000
    for(;;){
      const state=JSON.parse(await sql(`SELECT json_build_object('delivered',count(*) FILTER(WHERE delivered_at IS NOT NULL),'next',max(extract(epoch FROM available_at)*1000) FILTER(WHERE delivered_at IS NULL)) FROM notification_outbox WHERE event_type='draft_on_clock' AND data->>'draftId'='${draftId}'`))
      if(state.delivered===original.length)break
      assert.ok(await now()<deadline,'Draft push receipts must settle within seventy business minutes')
      await move(Math.min(deadline,Math.max(await now()+60000,Number(state.next??0)+60000)))
    }
    report.rookieReceiptWaitSeconds=(await now()-began)/1000
  }
  return original
}
