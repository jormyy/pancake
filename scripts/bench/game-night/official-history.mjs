import assert from 'node:assert/strict'
import { overlayLiveScores } from '../../../core/cjs/index.js'
import { delay, id, quote } from './common.mjs'
import { startPhones } from './phones.mjs'

export async function verifyOfficialHistory(stack, publicFeed) {
  const gameId=id(800001),playerId=id(1001)
  const original=JSON.parse(await stack.sql(`SELECT jsonb_build_object('game',to_jsonb(g),'stats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.player_id) FROM public.player_game_stats s WHERE s.game_id=g.id)) FROM public.nba_games g WHERE g.id=${quote(gameId)}`))
  assert.equal(original.game.status,'Final')
  assert.ok(original.stats.length)
  let phones
  const publish=async stats=>{
    await stack.sql(`SELECT public.save_final_game_snapshot_atomic(${quote(gameId)},${quote(original.game.nba_game_id)},${quote(JSON.stringify(stats))}::jsonb,clock_timestamp(),${original.game.home_score},${original.game.away_score},'Final');
      DO $$ DECLARE token jsonb; payload jsonb; BEGIN
      token:=public.capture_score_inputs('${id(2)}',${original.game.week_number});
      SELECT jsonb_agg(jsonb_build_object('id',m.id,'input_token',token,'home_points',
        (SELECT COALESCE(sum(public.compute_fantasy_points(s.id,m.league_id)),0) FROM public.weekly_lineups l JOIN public.player_game_stats s ON s.player_id=l.player_id AND s.game_date=l.game_date WHERE l.league_season_id=m.league_season_id AND l.member_id=m.home_member_id AND l.week_number=${original.game.week_number} AND l.slot_type NOT IN ('BE','IR')),
        'away_points',(SELECT COALESCE(sum(public.compute_fantasy_points(s.id,m.league_id)),0) FROM public.weekly_lineups l JOIN public.player_game_stats s ON s.player_id=l.player_id AND s.game_date=l.game_date WHERE l.league_season_id=m.league_season_id AND l.member_id=m.away_member_id AND l.week_number=${original.game.week_number} AND l.slot_type NOT IN ('BE','IR')))) INTO payload
        FROM public.matchups m WHERE m.league_season_id='${id(2)}' AND m.week_number=${original.game.week_number};
      PERFORM public.update_score_points_atomic('${id(1)}','${id(2)}',${original.game.week_number},payload); END $$;`)
  }
  try {
    phones=await startPhones(stack,publicFeed)
    const target=phones.phones[0].view.liveBasis.find(m=>m.players.some(p=>p.playerId===playerId))
    assert.ok(target,'The fixture correction must affect an active lineup')
    const scoring=phones.phones[0].view.context.league.scoring_settings
    const perPoint=Number(scoring.points ?? 1)
    const member=target.players.find(player=>player.playerId===playerId)?.memberId
    assert.ok(member===target.homeMemberId || member===target.awayMemberId)
    const corrected=original.stats.map(row=>row.player_id===playerId?{...row,points:row.points+1}:row)
    const score=phone=>overlayLiveScores(phone.view.liveBasis,phone.snapshot,scoring,Date.now()).matchups.find(m=>m.id===target.id)
    const initial=score(phones.phones[0])
    const expected={homePoints:initial.homePoints+(member===target.homeMemberId?perPoint:0),awayPoints:initial.awayPoints+(member===target.awayMemberId?perPoint:0)}
    const matches=()=>phones.phones.every(phone=>{
      const actual=score(phone)
      return actual.homePoints===expected.homePoints && actual.awayPoints===expected.awayPoints
    })
    assert.equal(matches(),false,'An omitted correction must fail the phone check')
    const started=Date.now()
    await publish(corrected)
    while(!matches() && Date.now()-started<45000)await delay(250)
    assert.ok(matches(),JSON.stringify({message:'Every phone must show the official stat correction within 45 seconds',expected,actual:phones.phones.map(phone=>({phone:phone.index,score:score(phone),error:phone.error,broadcasts:phone.broadcasts}))}))
    const report={passed:true,phones:phones.phones.length,correctionMs:Date.now()-started,omittedCorrectionRejected:true,
      officialScore:expected,receivedBroadcasts:phones.snapshot().map(row=>({phone:row.phone,broadcasts:row.broadcasts}))}
    const log=JSON.parse(await stack.sql(`BEGIN; SET LOCAL request.jwt.claim.sub='${id(101)}'; SELECT public.view_player('${id(1)}','${id(201)}',jsonb_build_object('playerId','${playerId}','section','games','seasonYear',${original.game.season_year})); ROLLBACK;`))
    assert.equal(log.lines.find(row=>row.nba_games.id===gameId)?.points,corrected.find(row=>row.player_id===playerId).points)
    report.playerLogOfficial=true
    return report
  } finally {
    await phones?.close()
    await publish(original.stats)
  }
}
