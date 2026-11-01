const maxVersion=9223372036854775807n

export function advancePhoneVersion(current,value) {
  const next=typeof value==='number' && Number.isSafeInteger(value) ? String(value) : value
  if(typeof next!=='string' || !/^(0|[1-9]\d{0,18})$/.test(next) || BigInt(next)>maxVersion)return current
  return BigInt(next)>BigInt(current) ? next : current
}

export function phoneChange(message,leagueId) {
  const row=message?.payload
  if(!row || row.league_id!==leagueId)return {refresh:false}
  if(row.topic==='version') {
    const change=Array.isArray(row.details) && row.details.length===1 ? row.details[0] : null
    if(!change || !change.scope || typeof change.scope!=='object' || Array.isArray(change.scope)
      || typeof change.topic!=='string' || typeof change.created_at!=='string'
      || advancePhoneVersion('0',change.version)==='0')return {refresh:false}
    return {refresh:true,version:change.version}
  }
  return {refresh:['lineup','roster','score','game','stat','player_stats','inventory','resources'].includes(row.topic)}
}
