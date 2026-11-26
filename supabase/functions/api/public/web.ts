import { definition, policy, publicContract, READS_PER_MINUTE, resourceNames, type Resource } from './policy.ts'

type Row = Record<string, unknown>
type Link = [label: string, resource: Resource, params: Record<string, string>]
type LeagueSummary = { id: string; name: string; seasonYear: number | null }
export type LeagueContext = { league: LeagueSummary | null }
export type WebPage = LeagueContext & {
  base: string; resource: Resource; url: URL; items: Row[]; nextCursor: string | null; readAt: Date; index: boolean
}

const titles: Record<Resource, string> = {
  leagues: 'Public leagues', league: 'League settings', seasons: 'Seasons', teams: 'Teams', players: 'Players',
  'free-agents': 'Free agents', rosters: 'Team roster', standings: 'Standings', matchups: 'Matchups', scores: 'Scores',
  schedule: 'Schedule', 'player-stats': 'Player season statistics', projections: 'Player projections', drafts: 'Drafts',
  'draft-results': 'Draft results', picks: 'Draft picks', trades: 'Completed trades', 'trade-assets': 'Completed trade assets',
  transactions: 'Transactions',
}
const seasonScoped = (resource: Resource) => definition(resource).filters.season?.length === 0
const teamLinks = (row: Row): Link[] => [
  ['Roster', 'rosters', { team: String(row.id) }], ['Schedule', 'schedule', { team: String(row.id) }],
  ['Transactions', 'transactions', { team: String(row.id) }], ['Picks', 'picks', { team: String(row.id) }],
]
const playerLinks = (row: Row): Link[] => [['Season stats', 'player-stats', { player: String(row.id) }], ['Projections', 'projections', { player: String(row.id) }]]
const rowLinks: Partial<Record<Resource, (row: Row) => Link[]>> = {
  leagues: row => [['League home', 'league', { league: String(row.id) }]],
  seasons: row => [['League in this season', 'league', { season: String(row.seasonYear) }], ['Schedule', 'schedule', { season: String(row.seasonYear) }]],
  teams: teamLinks, standings: teamLinks,
  rosters: row => [['Season stats', 'player-stats', { player: String((row.player as Row | null)?.id) }]],
  players: playerLinks, 'free-agents': playerLinks, projections: playerLinks,
  drafts: row => [['Results', 'draft-results', { draft: String(row.id) }]],
  trades: row => [['Assets', 'trade-assets', { trade: String(row.id) }]],
}

export function cell(value: unknown): string {
  if (value === null || value === undefined) return '—'
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
}
export const columns = (resource: Resource) => Object.keys(publicContract.resources[resource].properties.items.items.properties)

function address(base: string, kind: 'web' | 'v2', resource: Resource | null, params: Iterable<[string, string]>) {
  const query = new URLSearchParams([...params]).toString()
  return `${base}/public/${kind}${resource ? `/${resource}` : ''}${query ? `?${query}` : ''}`
}

export function renderPage(page: WebPage): string {
  const { base, resource, url, items, nextCursor, readAt, league } = page
  const given = [...url.searchParams]
  const options = Object.fromEntries(given)
  const leagueParams = (extra: Record<string, string>): [string, string][] => [...(league ? [['league', league.id] as [string, string]] : []), ...Object.entries(extra)]
  const web = (target: Resource, extra: Record<string, string>) => address(base, 'web', target, target === 'leagues' ? Object.entries(extra) : leagueParams(extra))
  const spec = definition(resource)
  const lines: string[] = []
  const heading = league ? `${league.name}: ${titles[resource]}` : page.index ? 'Pancake public league data' : titles[resource]
  lines.push(`# ${heading}`, '')
  if (page.index) {
    lines.push('Pancake is a dynasty fantasy basketball app. Every league that is not deleted is public here.',
      'Reading needs no account, no JavaScript and no tools. Every page is plain Markdown with ordinary links.', '')
  }
  if (league) {
    lines.push(`- League: ${cell(league.name)} (id ${league.id}). League home: ${web('league', {})}`)
    lines.push(`- Season: ${league.seasonYear ?? 'not set'}${options.season ? ` (requested season=${options.season})` : ' (the league\'s current season unless a season option is given)'}`)
  }
  lines.push(`- Freshness: read live from the Pancake database at ${readAt.toISOString()}. Nothing on this page is cached.`)
  lines.push(`- This page: ${address(base, 'web', page.index ? null : resource, given)}`)
  lines.push(`- Same data as JSON: ${address(base, 'v2', resource, given)}`)
  lines.push(`- Same data from the CLI: \`pancake ${resource}${given.map(([key, value]) => ` --${key} ${value}`).join('')} --json\``)
  lines.push('')
  if (resource === 'leagues') {
    const query = options.query
    const more = nextCursor ? ' or more' : ''
    if (query !== undefined) {
      const exact = items.filter(item => String(item.name).toLowerCase() === query.toLowerCase())
      if (items.length === 0) lines.push(`No public league name contains "${cell(query)}". Browse every public league: ${web('leagues', {})}`)
      else if (items.length === 1 && !nextCursor) lines.push(`One public league name contains "${cell(query)}": ${cell(items[0].name)}. Open its league home: ${web('league', { league: String(items[0].id) })}`)
      else if (exact.length === 1) lines.push(`Exact name match: ${cell(exact[0].name)}. Open its league home: ${web('league', { league: String(exact[0].id) })}`, `${items.length - 1}${more} other public league names also contain "${cell(query)}"; they are listed below.`)
      else lines.push(`${items.length}${more} public league names contain "${cell(query)}". The name is ambiguous; choose one league below.`)
    } else {
      lines.push(`Public leagues on this page: ${items.length}${more}.`)
    }
    lines.push('', `Find a league by name: open ${base}/public/web/leagues?query=NAME with NAME replaced by the full name or any part of it. Matching ignores letter case.`)
    lines.push(`Example: ${web('leagues', { query: 'league' })}`, '')
  }
  if (resource === 'league' && league) {
    lines.push('## League pages', '')
    const season: Record<string, string> = options.season ? { season: options.season } : {}
    for (const target of resourceNames.filter(name => !['leagues', 'league', 'rosters', 'trade-assets'].includes(name))) {
      lines.push(`- ${titles[target]}: ${web(target, seasonScoped(target) ? season : {})}`)
    }
    lines.push('- Team rosters: open Teams or Standings and follow a team\'s Roster link.')
    lines.push('- Trade assets: open Completed trades and follow a trade\'s Assets link.', '')
    lines.push('Standings rank 1 is the league leader. A team\'s Schedule link lists its matchups by week; the first week with finalized=false is its current or next matchup.', '')
  }
  lines.push(`## ${titles[resource]}`, '')
  const fields = columns(resource)
  const linker = rowLinks[resource]
  const carried: Record<string, string> = options.season && seasonScoped(resource) ? { season: options.season } : {}
  if (items.length === 0) lines.push('No records match these options.')
  else {
    lines.push(`| ${fields.join(' | ')}${linker ? ' | pages' : ''} |`, `|${' --- |'.repeat(fields.length + (linker ? 1 : 0))}`)
    for (const row of items) {
      const links = linker ? ` | ${linker(row).map(([label, target, extra]) => `[${label}](${web(target, { ...(seasonScoped(target) ? carried : {}), ...extra })})`).join(' ')}` : ''
      lines.push(`| ${fields.map(field => cell(row[field])).join(' | ')}${links} |`)
    }
  }
  lines.push('', nextCursor
    ? `Records on this page: ${items.length}. More records exist. Next page: ${address(base, 'web', resource, [...given.filter(([key]) => key !== 'cursor'), ['cursor', nextCursor]])}`
    : `Records on this page: ${items.length}. This is the last page.`, '')
  lines.push('## Options', '')
  lines.push(`Add options to this page's address as query parameters. They match the CLI options and the JSON API.`)
  if (resource !== 'leagues') lines.push('- league: league id (required).')
  for (const [filter, fields] of Object.entries(spec.filters)) lines.push(`- ${filter}: ${filterHelp(filter, fields)}`)
  lines.push(`- sort: one of ${columns(resource).filter(field => sortable(resource, field)).join(', ')}. Default ${spec.order[0]}.`)
  lines.push(`- direction: asc or desc. Default ${spec.direction ?? 'asc'}.`)
  lines.push(`- limit: 1 to ${policy.maxLimit} records per page. Default ${policy.defaultLimit}.`)
  lines.push('- cursor: copy it from the Next page link; keep the other options unchanged.', '')
  lines.push('## Privacy', '', 'Pages show only public league data: no accounts, emails, claims, bids, lineups, pending offers, votes or estimates. Only completed trades appear.', '')
  lines.push(`Start page: ${base}/public/web`, `Agent guide: https://pancakedynasty.vercel.app/agents.md`)
  return `${lines.join('\n')}\n`
}

function sortable(resource: Resource, field: string) {
  const schema = (definition(resource).fields[field]?.schema ?? {}) as { type?: string | string[] }
  return !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(type => type === 'object' || type === 'array')
}
function filterHelp(filter: string, fields: string[]) {
  if (filter === 'query') return `any part of ${fields.join(' or ')}, ignoring letter case.`
  if (filter === 'season') return fields.length ? `season year (${fields.join(', ')}).` : 'season year; defaults to the league\'s current season.'
  if (filter === 'week') return 'week number within the season.'
  if (filter === 'position') return 'player position, exactly as listed.'
  return `${filter} id (${fields.join(' or ')}).`
}

export function renderFailure(status: number, base: string): string {
  const reasons: Record<number, string> = {
    400: 'The options are invalid. Check the option names and values on the resource page, and copy cursors unchanged.',
    404: 'This public page does not exist. Unknown and private ids are reported the same way.',
    405: 'Public pages are read-only.',
    410: 'This API version is retired.',
    429: `The read limit was reached. Each client IP may make ${READS_PER_MINUTE} public reads a minute; wait for the Retry-After seconds and try again.`,
    503: 'Public data is unavailable right now. Try again shortly.',
  }
  return `# Pancake public data: error ${status}\n\n${reasons[status] ?? reasons[503]}\n\nStart page: ${base}/public/web\n`
}
