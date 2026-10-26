import { originUrl } from './common.mjs'

export const fantasyPaths = ['daily-overall.php', 'avg-weekly-overall.php', 'weekly-overall.php']
export const fantasyTypes = ['daily', 'weekly_avg', 'weekly_total']
export const careerSources = ['espn-career-stats', 'espn-career-biography', 'espn-career-search', 'nba-career-profile']

export function providerTransport(value) {
  const url = new URL(value)
  if (url.username || url.password || url.hash) return url
  if (url.origin === 'https://api.sleeper.app' && /^\/projections\/nba\/\d{4}\/\d+$/.test(url.pathname) && url.search === '?season_type=regular') return new URL(`${originUrl('replay')}/sleeper${url.pathname}${url.search}`)
  if (url.origin === 'https://www.fantasypros.com' && fantasyPaths.some(file => url.pathname === `/nba/projections/${file}`) && !url.search) return new URL(`${originUrl('replay')}/fantasypros${url.pathname}`)
  return url
}

export function unavailableResponse(source, at) {
  return { code: 'HISTORICAL_UNAVAILABLE', source, at: new Date(at).toISOString(), policy: 'retained-corpus-v1' }
}

export function gapSource(pathname) {
  if (/^\/career\/athletes\/\d+\/stats$/.test(pathname)) return 'espn-career-stats'
  if (/^\/career\/athletes\/\d+$/.test(pathname)) return 'espn-career-biography'
  if (pathname === '/career-search') return 'espn-career-search'
  if (/^\/nba\/player\/\d+$/.test(pathname)) return 'nba-career-profile'
  if (pathname === '/fantasy-basketball-dynasty-rankings') return 'hashtag-rankings'
  if (pathname === '/sleeper/players/nba') return 'sleeper-identities'
  if (/^\/sleeper\/projections\/nba\/\d{4}\/\d+$/.test(pathname)) return 'sleeper-projections'
  if (fantasyPaths.some(file => pathname === `/fantasypros/nba/projections/${file}`)) return 'fantasypros-projections'
  return null
}

export function validGapRoute(source, url) {
  if (url.hash || url.username || url.password) return false
  if (source === 'espn-career-stats') return gapSource(url.pathname) === source && url.search === '?seasontype=2'
  if (source === 'espn-career-search') {
    const entries = [...url.searchParams]
    return url.pathname === '/career-search' && entries.length === 3 && entries[0][0] === 'query' && entries[0][1].trim().length > 0 && entries[1][0] === 'type' && entries[1][1] === 'player' && entries[2][0] === 'limit' && entries[2][1] === '50'
  }
  if (source === 'sleeper-projections') return gapSource(url.pathname) === source && url.search === '?season_type=regular'
  if (source === 'nba-draft-before-publication') return !url.search && /^\/nba\/(news\/\d{4}-nba-draft-order|draft\/\d{4})$/.test(url.pathname) || url.pathname === '/stats/stats/drafthistory' && /^\?LeagueID=00&Season=\d{4}&RoundNum=&RoundPick=&TeamID=0&Overall_Pick=&SeasonType=$/.test(url.search)
  if (source === 'espn-injury-observations') return url.pathname === '/espn/injuries' && !url.search
  return gapSource(url.pathname) === source && !url.search
}
