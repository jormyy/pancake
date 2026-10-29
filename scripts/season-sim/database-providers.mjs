import assert from 'node:assert/strict'

export function sleeperSnapshot(players) {
  const entries=players.filter(row=>row.nba_team&&/^\d+$/.test(row.sleeper_id??'')).map(row=>{
    assert.ok(row.first_name&&row.last_name,'A known provider identity requires its stored name')
    return [row.sleeper_id,{player_id:row.sleeper_id,sport:'nba',first_name:row.first_name,last_name:row.last_name,
      team:row.nba_team,position:row.position,years_exp:row.years_exp}]
  })
  assert.ok(entries.length>0,'The backup must contain known Sleeper identities')
  assert.equal(new Set(entries.map(([id])=>id)).size,entries.length,'Stored provider identities must be unique')
  return {provenance:'SYNTHETIC',source:'Restored backup identities and metadata; no invented provider IDs.',players:Object.fromEntries(entries)}
}

export function providerSnapshot(players,seasonYear,projections=[]) {
  assert.ok(Number.isInteger(seasonYear))
  const result=sleeperSnapshot(players)
  result.espn=players.filter(row=>row.nba_team&&/^\d+$/.test(row.espn_id??'')).map(row=>({
    id:row.espn_id,firstName:row.first_name,lastName:row.last_name,fullName:`${row.first_name} ${row.last_name}`,
    team:row.nba_team,position:{abbreviation:row.position},experience:{years:row.years_exp==null?undefined:row.years_exp+1},status:{type:'active'},dateOfBirth:row.birthdate,
  }))
  result.nbaIndex={resultSets:[{headers:['PERSON_ID','PLAYER_FIRST_NAME','PLAYER_LAST_NAME','ROSTER_STATUS','TEAM_ABBREVIATION','POSITION','FROM_YEAR'],
    rowSet:players.filter(row=>/^\d+$/.test(row.nba_id??'')).map(row=>[Number(row.nba_id),row.first_name,row.last_name,Number(Boolean(row.nba_team)),row.nba_team,row.position,row.years_exp==null?null:seasonYear-1-row.years_exp])}]}
  assert.equal(new Set(result.espn.map(row=>row.id)).size,result.espn.length)
  const owners=new Map(players.map(row=>[row.id,row]))
  result.projections=projections.map(row=>{
    const owner=owners.get(row.player_id)
    assert.ok(owner,'Stored projections require an existing player')
    return {player_id:row.sleeper_id,game_id:row.source_game_id,date:row.game_date,team:row.team,opponent:row.opponent,
      week:row.week_number,season:String(row.season_year-1),season_type:'regular',sport:'nba',category:'proj',company:'rotowire',last_modified:Number(row.last_modified),
      player:{first_name:owner.first_name,last_name:owner.last_name,position:owner.position,years_exp:owner.years_exp},
      stats:{gp:1,pts:row.points,reb:row.rebounds,ast:row.assists,stl:row.steals,blk:row.blocks,to:row.turnovers,
        fgm:row.field_goals_made,fga:row.field_goals_attempted,ftm:row.free_throws_made,fta:row.free_throws_attempted,
        tpm:row.three_pointers_made,tpa:row.three_pointers_attempted,sp:row.minutes*60,dd:row.double_doubles??0,td:row.triple_doubles??0}}
  })
  return result
}
