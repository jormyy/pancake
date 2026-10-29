import assert from 'node:assert/strict'

const views={POINT_5:{type:'POINT',forecast:5,source:'hashtagbasketball.com',minimum:300},POINT_3:{type:'POINT',forecast:3,source:'hashtagbasketball.com/points-3',minimum:300},ROOKIE:{type:'ROOKIE',forecast:5,source:'hashtagbasketball.com/rookie',minimum:30}}
const stats={GP:'games_played','FG%':'field_goal_pct','FT%':'free_throw_pct','3PM':'three_pointers_made',PTS:'points',REB:'rebounds',AST:'assists',STL:'steals',BLK:'blocks',TO:'turnovers'}
const html=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;')

export function rankingPage(rows,form=null){
  const type=form?.get('ctl00$ContentPlaceHolder1$DDTYPE')??'POINT'
  const forecast=Number(form?.get('ctl00$ContentPlaceHolder1$DDFORECAST')??5)
  const view=Object.values(views).find(view=>view.type===type&&view.forecast===forecast)
  assert.ok(view,'Unknown stored ranking view')
  const selected=rows.filter(row=>row.source===view.source).sort((a,b)=>a.source_rank-b.source_rank)
  assert.ok(selected.length>=view.minimum,'The backup lacks a complete ranking view')
  assert.equal(new Set(selected.map(row=>row.source_rank)).size,selected.length,'Duplicate stored ranking position')
  const body=selected.map(row=>{
    const fields=Object.entries(stats).map(([label,key])=>`<td>${html(row[key])}<span class="lbl">${label}</span></td>`).join('')
    const trend=row.rank_change<0?'down':row.rank_change>0?'up':'none'
    const sourceId=row.source_player_id==null?'':`<input type="hidden" value="${html(row.source_player_id)}">`
    return `<tr><td class="dynasty d-none"><span>#${row.source_rank}</span><span class="small"><i class="arrow-circle-${trend}"></i>${Math.abs(row.rank_change??0)}</span></td><td class="dynasty d-none">${html(row.source_player_name)}${sourceId}</td><td class="dynasty d-none">${html(row.age)}</td><td class="dynasty d-none">${html(row.source_team)}</td><td class="dynasty d-none">${html(row.source_positions.join(','))}</td><td class="dynasty d-none"><div class="dyn-statwrap"><table class="dyn-statgrid"><tbody><tr>${fields}</tr></tbody></table></div>${html(row.comment)}</td></tr>`
  }).join('')
  return `<form><input name="__VIEWSTATE" value="stored-ranking-replay"><select name="ctl00$ContentPlaceHolder1$DDTYPE"><option value="${view.type}" selected>${view.type}</option></select><select name="ctl00$ContentPlaceHolder1$DDFORECAST"><option value="${view.forecast}" selected>${view.forecast}</option></select></form><table class="table--statistics"><tbody>${body}</tbody></table>`
}
