import { homeHintAffects, homeVersionAffects, homeForecastOnly, homeScoresOnly } from '@pancake/core'

const maxVersion=9223372036854775807n

export function advancePhoneVersion(current,value) {
  const next=typeof value==='number' && Number.isSafeInteger(value) ? String(value) : value
  if(typeof next!=='string' || !/^(0|[1-9]\d{0,18})$/.test(next) || BigInt(next)>maxVersion)return current
  return BigInt(next)>BigInt(current) ? next : current
}

export function phoneChange(message,leagueId,since='0',selection={}) {
  const payload=message?.payload
  if(!payload || typeof payload!=='object')return {refresh:false}
  const rows=Array.isArray(payload.hints) ? payload.hints.flatMap(hint=>
    hint && ['INSERT','UPDATE'].includes(hint.event) && hint.row && typeof hint.row==='object'
      ? [{league_id:leagueId,...hint.row}] : [])
    : payload.table==='league_change_hints' && payload.schema==='public'
      ? ['INSERT','UPDATE'].includes(payload.eventType) ? [payload.new] : []
      : []
  let refresh=false,forecastOnly=true,scoreOnly=true,version='0'
  const received=new Set()
  for(const row of rows) {
    if(!row || row.league_id!==leagueId)continue
    if(row.topic==='version') {
      const change=Array.isArray(row.details) && row.details.length===1 ? row.details[0] : null
      if(!change || !change.scope || typeof change.scope!=='object' || Array.isArray(change.scope)
        || typeof change.version!=='string' || typeof change.topic!=='string' || typeof change.created_at!=='string'
        || advancePhoneVersion('0',change.version)==='0')continue
      version=advancePhoneVersion(version,change.version)
      if(BigInt(change.version)>BigInt(since))received.add(change.version)
      if(BigInt(change.version)>BigInt(since) && homeVersionAffects(change,selection)){refresh=true;forecastOnly &&= homeForecastOnly(change);scoreOnly &&= homeScoresOnly(change)}
    } else if(['lineup','roster','score','game','stat','player_stats','inventory','resources'].includes(row.topic) && homeHintAffects(row,selection)){refresh=true;forecastOnly=false;scoreOnly &&= ['score','stat','player_stats','game'].includes(row.topic)}
  }
  const recover=BigInt(version)>BigInt(since)+BigInt(received.size)
  if(recover){refresh=true;forecastOnly=false;scoreOnly=false}
  return {refresh,...(recover?{recover:true}:{}),...(refresh && forecastOnly?{forecastOnly:true}:{}),...(refresh && scoreOnly && version!=='0'?{scoreOnly:true}:{}),...(version!=='0'?{version}:{})}
}
