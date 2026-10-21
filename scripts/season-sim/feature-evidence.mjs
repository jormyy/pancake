import assert from 'node:assert/strict'
import {readFile,writeFile}from'node:fs/promises'
import path from'node:path'
import {miniRoot,writeJson,laneDirectory}from'./common.mjs'
import {sqlJson}from'./local-stack.mjs'
import {statPoints}from'./score-oracle.mjs'
import {checkMatchupOrder,checkPlayoffEvidence,checkPlayersPool,matchupOrder}from'./feature-oracles.mjs'

export function observedSeasonOrder(season,members){
  const ids=members.map(row=>row.id).sort()
  for(const[key,value]of Object.entries(season))if(/(?:matchup|round_robin).*order|order.*member/i.test(key)&&Array.isArray(value)&&JSON.stringify([...value].sort())===JSON.stringify(ids))return value
  return null
}

async function emit(name,input,check){
  const directory=await laneDirectory(path.join(miniRoot,'evidence'))
  let result
  try{result={status:'PASS',...check()}}catch(error){result={status:'FAILED',error:error.message}}
  if(result.phase==='Playoffs not measured'){result.status='not measured';result.fitStatus='PASS';console.log(`${name} configured fit: PASS`)}
  await writeJson(path.join(directory,`${name}.json`),{provenance:'SYNTHETIC fantasy actions; independently checked product tables',input,...result})
  const table=Array.isArray(result.table)?result.table:input.rows??[]
  await writeFile(path.join(directory,`${name}.md`),`# ${name}\n\n${result.status}: ${result.error??result.phase??'Observed checks pass'}\n\n\`\`\`json\n${JSON.stringify(table,null,2)}\n\`\`\`\n`)
  if(table.length){
    const keys=[...new Set(table.flatMap(row=>Object.keys(row)))],cell=value=>'\"'+String(typeof value==='object'?JSON.stringify(value):value??'').replaceAll('\"','\"\"')+'\"'
    await writeFile(path.join(directory,`${name}.csv`),[keys.join(','),...table.map(row=>keys.map(key=>cell(row[key])).join(','))].join('\n')+'\n')
  }
  console.log(`${name}: ${result.status}${result.error?' '+result.error:''}`)
  return result
}

export async function captureSeasonFeatures(c,profile,label,report){
  const data=await sqlJson(`SELECT json_build_object('rows',(SELECT coalesce(json_agg(m),'[]') FROM matchups m WHERE league_season_id='${c.leagueSeasonId}'),'standings',(SELECT coalesce(json_agg(s),'[]') FROM standings s WHERE league_season_id='${c.leagueSeasonId}'),'members',(SELECT json_agg(m ORDER BY joined_at,id) FROM league_members m WHERE league_id='${c.leagueId}'),'season',(SELECT row_to_json(s) FROM league_seasons s WHERE id='${c.leagueSeasonId}'),'settings',(SELECT row_to_json(l) FROM leagues l WHERE id='${c.leagueId}'),'at',now())`,'F1/F2 product table export')
  return extractFeatureInput({...data,profile,label},report)
}

async function extractFeatureInput(data,report){
  const{profile,label,season,members,rows,standings,settings}=data
  const directory=await laneDirectory(path.join(miniRoot,'evidence'))
  await writeJson(path.join(directory,`feature-input-${profile.year}-${label}.json`),data)
  report.featureCheckpoints??=[]
  const earlier=report.featureCheckpoints.filter(row=>row.year===profile.year)
  const previous=report.featureCheckpoints.filter(row=>row.year<profile.year&&row.f1.passed).at(-1)?.f1??null
  const order=observedSeasonOrder(season,members)
  const f1=await emit(`F1-${profile.year}-${label}`,{...data,order},()=>checkMatchupOrder({rows,members,order,earlier:earlier.map(row=>row.table),previous}))
  const f2=await emit(`F2-${profile.year}-${label}`,data,()=>checkPlayoffEvidence({rows,standings,seasonId:season.id,seeds:season.playoff_bracket_seed_ids,members,settings,calendar:profile.calendar,seasonEnd:profile.end,before:earlier.flatMap(row=>row.playoffRows)}))
  for(const[area,result]of [['matchup-order',f1],['playoff-fit',f2]])if(result.status==='FAILED'){report.failures??=[];report.failures.push({name:'AssertionError',area,message:result.error,phase:`${profile.year}:${label}`})}
  const record={year:profile.year,label,businessAt:data.at,f1,f2,table:matchupOrder(rows),playoffRows:rows.filter(row=>row.matchup_type!=='regular_season')}
  report.featureCheckpoints.push(record)
  return record
}

export async function extractFeatureFile(file){
  assert.ok(path.resolve(file).startsWith(path.resolve(miniRoot)+'/'),'Export input stays under the lane root')
  return extractFeatureInput(JSON.parse(await readFile(file,'utf8')),{})
}

export function playerAverages(stats,settings){
  const totals=new Map()
  for(const stat of stats.filter(row=>!row.did_not_play)){
    const value=totals.get(stat.player_id)??{total:0,games:0}
    value.total+=statPoints(stat,settings);value.games++;totals.set(stat.player_id,value)
  }
  return Object.fromEntries([...totals].map(([id,value])=>[id,Math.sign(value.total)*Math.round(Math.abs(Number((value.total/value.games).toFixed(8)))*100)/100]))
}

export async function capturePlayers(c,label,report){
  const input=await sqlJson(`SELECT json_build_object('at',now(),'played',EXISTS(SELECT 1 FROM nba_games g WHERE g.season_year=${c.seasonYear} AND g.nba_game_id ~ '^002[0-9]{7}$' AND (g.status='Final' OR EXISTS(SELECT 1 FROM player_game_stats s WHERE s.game_id=g.id AND NOT s.did_not_play AND (s.minutes_played>0 OR s.points>0 OR s.rebounds>0 OR s.assists>0 OR s.steals>0 OR s.blocks>0 OR s.turnovers>0 OR s.field_goals_attempted>0 OR s.free_throws_attempted>0)))),'ids',(SELECT json_agg(id) FROM players),'settings',(SELECT scoring_settings FROM leagues WHERE id='${c.leagueId}'))`,'F3 played-season state')
  const expectedYear=c.seasonYear-(input.played?0:1)
  const stats=await sqlJson(`SELECT coalesce(json_agg(s),'[]') FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id WHERE g.season_year=${expectedYear} AND g.nba_game_id ~ '^002[0-9]{7}$'`,'F3 independent per-player averaging inputs')
  const rows=[]
  for(let offset=0;;offset+=100){
    const page=await c.rpc(c.users[0],'search_players',{p_league_id:c.leagueId,p_limit:100,p_offset:offset,...(offset?{p_season_year:rows[0].stats_season_year}:{})})
    rows.push(...page)
    if(page.length<100)break
    assert.ok(offset<10000,'Players pagination must terminate')
  }
  const expected=playerAverages(stats,input.settings)
  const result=await emit(`F3-${c.seasonYear}-${label}`,{...input,expectedYear,rows,expected},()=>checkPlayersPool({rows,expected,expectedYear,allPlayerIds:input.ids}))
  if(result.status==='FAILED'){report.failures??=[];report.failures.push({name:'AssertionError',area:'players-sort',message:result.error,phase:`${c.seasonYear}:${label}`})}
  report.playersEvidence??=[];report.playersEvidence.push({year:c.seasonYear,label,businessAt:input.at,...result})
  return result
}
