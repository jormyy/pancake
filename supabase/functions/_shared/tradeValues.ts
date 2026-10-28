const TRADE_VALUE_URL = 'https://www.onenumberhoops.com/api/players'

export type TradeValue = {
  sourceId: string
  name: string
  team: string
  positions: string[]
  rank: number
  rawValue: number
  value: number
  age: number | null
  kind: 'player' | 'pick'
  year: number | null
  round: number | null
  tier: string | null
}

export type TradeValuePlayer = {
  id: string
  display_name: string | null
  nba_team: string | null
  position: string | null
  eligible_positions: string[] | null
}

const contract = (message: string): never => { throw new Error(`OneNumberHoops contract: ${message}`) }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return contract('expected an object')
  return value as Record<string, unknown>
}
const requiredText = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) return contract(`missing ${field}`)
  return value.trim()
}

export function parseTradeValues(text: string): TradeValue[] {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return contract('response is not JSON') }
  const response = object(parsed)
  if (response.success !== true || !Array.isArray(response.data)) return contract('expected success and data array')
  const values = response.data.map((entry): TradeValue => {
    const row = object(entry)
    const sourceId = requiredText(row.id, 'id')
    const name = requiredText(row.player, 'player')
    const team = requiredText(row.team, 'team')
    const pos = requiredText(row.pos, 'pos')
    if (!Number.isInteger(row.rank) || Number(row.rank) < 1) return contract(`invalid rank for ${name}`)
    if (typeof row.value !== 'number' || !Number.isFinite(row.value) || row.value < 0 || row.value > 10000) return contract(`invalid value for ${name}`)
    const pick = /^(20\d{2}) (Early|Mid|Late) (1st|2nd) Round Pick$/.exec(name)
    const positions = pos.split(/[,/]/).map(p => p.trim().toUpperCase())
    if (positions.some(p => !['PG', 'SG', 'SF', 'PF', 'C', 'PICK'].includes(p))) return contract(`invalid positions for ${name}`)
    if ((team === 'DRAFT' || positions.includes('PICK')) !== Boolean(pick)) return contract(`invalid pick label ${name}`)
    if (!pick && (typeof row.age !== 'number' || !Number.isFinite(row.age) || row.age < 15 || row.age > 60)) return contract(`invalid age for ${name}`)
    return { sourceId, name, team, positions, rank: Number(row.rank), rawValue: row.value, value: row.value / 10,
      age: pick ? null : Number(row.age), kind: pick ? 'pick' : 'player', year: pick ? Number(pick[1]) : null,
      round: pick ? Number(pick[3][0]) : null, tier: pick ? pick[2].toLowerCase() : null }
  })
  if (values.filter(v => v.kind === 'player').length !== 450 || values.filter(v => v.kind === 'pick').length !== 18) return contract('expected 450 players and 18 picks')
  if (new Set(values.map(v => v.sourceId)).size !== values.length || new Set(values.map(v => v.rank)).size !== values.length) return contract('duplicate id or rank')
  if (Math.max(...values.map(v => v.rank)) !== 468) return contract('rank sequence changed')
  const picks = values.filter(v => v.kind === 'pick')
  const years = [...new Set(picks.map(v => v.year!))].sort()
  if (years.length !== 3 || years[2] - years[0] !== 2 || new Set(picks.map(v => `${v.year}:${v.round}:${v.tier}`)).size !== 18) return contract('pick grid changed')
  return values
}

export function parseTradeValuesCsv(text: string): TradeValue[] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false, closed = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char !== '"') field += char
      else if (text[i + 1] === '"') { field += '"'; i++ }
      else { quoted = false; closed = true }
    } else if (char === '"') {
      if (field || closed) return contract('invalid CSV quote')
      quoted = true
    } else if (char === ',' || char === '\n') {
      row.push(field.replace(/\r$/, '')); field = ''
      closed = false
      if (char === '\n') { if (row.some(Boolean)) rows.push(row); row = [] }
    } else if (char !== '\r' || text[i + 1] !== '\n') {
      if (closed) return contract('characters after a CSV quote')
      field += char
    }
  }
  if (quoted) return contract('unterminated CSV quote')
  row.push(field.replace(/\r$/, ''))
  if (row.some(Boolean)) rows.push(row)
  if (rows.shift()?.join(',') !== 'source_id,name,team,positions,rank,value,age') return contract('CSV header changed')
  return parseTradeValues(JSON.stringify({ success: true, data: rows.map(fields => {
    if (fields.length !== 7 || !fields[4] || !fields[5]) return contract('invalid CSV row')
    return { id: fields[0], player: fields[1], team: fields[2], pos: fields[3], rank: Number(fields[4]), value: Number(fields[5]), age: fields[6] ? Number(fields[6]) : 0 }
  }) }))
}

export function normalizeTradeValueName(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase()
    .replace(/[’'`.]/g, '').replace(/[-_]/g, ' ').replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/\s+/g, ' ').trim()
}

const aliases: Record<string, string> = {
  'alexandre sarr': 'alex sarr', 'nicolas claxton': 'nic claxton', 'carlton carrington': 'bub carrington',
  'ronald holland': 'ron holland', 'ishmail wainright': 'ish wainright', 'aleksandar vezenkov': 'sasha vezenkov',
  'cui yongxi': 'yongxi cui', 'jacky cui': 'yongxi cui', 'nigel hayes': 'nigel hayes davis',
  'david jones': 'david jones garcia', 'robert dillingham': 'rob dillingham', 'cameron thomas': 'cam thomas',
  'cameron johnson': 'cam johnson', 'cameron whitmore': 'cam whitmore', 'cameron reddish': 'cam reddish',
  'nah shon hyland': 'bones hyland', 'nahshon hyland': 'bones hyland', 'kenyon martin': 'kj martin',
  'marjon beauchamp': 'mar jon beauchamp', 'aj johnson': 'a j johnson', 'aj green': 'a j green',
  'pj washington': 'p j washington', 'gg jackson': 'g g jackson', 'vj edgecombe': 'v j edgecombe',
}
const nameKey = (name: string) => {
  const normalized = normalizeTradeValueName(name)
  return (aliases[normalized] ?? normalized).replace(/\s/g, '')
}
function normalizeTradeValueTeam(team: string | null): string {
  const normalized = (team ?? '').trim().toUpperCase()
  return ({ GS: 'GSW', SA: 'SAS', NY: 'NYK', NO: 'NOP', NOR: 'NOP', PHO: 'PHX', BRK: 'BKN', NJ: 'BKN', UTAH: 'UTA', FA: '', TOT: '' } as Record<string, string>)[normalized] ?? normalized
}

export function matchTradeValues(values: TradeValue[], players: TradeValuePlayer[], overrides: Record<string, string> = {}) {
  const byName = new Map<string, TradeValuePlayer[]>()
  for (const player of players) {
    if (!player.display_name) continue
    const key = nameKey(player.display_name)
    byName.set(key, [...(byName.get(key) ?? []), player])
  }
  const used = new Set<string>()
  return values.filter(value => value.kind === 'player').map(value => {
    const candidates = byName.get(nameKey(value.name)) ?? []
    const compatible = candidates.filter(player => {
      const positions = new Set([player.position, ...(player.eligible_positions ?? [])].filter(Boolean))
      return value.positions.some(position => positions.has(position))
    })
    const sameTeam = compatible.filter(player => normalizeTradeValueTeam(player.nba_team) === normalizeTradeValueTeam(value.team))
    const best = sameTeam.length ? sameTeam : compatible
    const override = overrides[value.sourceId]
    const player = override ? players.find(player => player.id === override) : best.length === 1 ? best[0] : undefined
    const playerId = player && !used.has(player.id) ? player.id : null
    if (playerId) used.add(playerId)
    return { ...value, playerId, reason: playerId ? override ? 'reviewed' : sameTeam.length ? 'name-team-position' : 'name-position' : candidates.length ? 'ambiguous-or-position' : 'name-not-found', candidateIds: candidates.map(player => player.id) }
  })
}

export function thirdRoundTradeValue(secondRoundValue: number, replacementValue: number): number {
  if (![secondRoundValue, replacementValue].every(value => Number.isFinite(value) && value >= 0 && value <= 1000)) throw new Error('Invalid pick or replacement value')
  return Math.round(Math.max(secondRoundValue * 0.4, replacementValue) * 100) / 100
}


export type TradeValueStore = {
  claim: (requestId: string, signal: AbortSignal) => Promise<boolean>
  fail: (requestId: string, retry: number, retryDate: string | null, scheduleRetry: boolean, signal: AbortSignal) => Promise<unknown>
  cached: (signal: AbortSignal) => Promise<unknown>
  players: (signal: AbortSignal) => Promise<TradeValuePlayer[]>
  overrides: (signal: AbortSignal) => Promise<Record<string, string>>
  publish: (payload: { rows: unknown[]; picks: unknown[]; source: string; fetchedAt: string; mode: string; requestId: string | null }, signal: AbortSignal) => Promise<Record<string, unknown>>
}

export function cachedTradeValueSnapshot(state: { fetched_at: string | null; last_request_at: string | null; matched: number | null }) {
  if (!state.fetched_at || (state.last_request_at && Date.parse(state.last_request_at) > Date.parse(state.fetched_at))) {
    throw new Error('The daily source attempt did not publish a snapshot; a retry is pending or a CSV import is needed')
  }
  return { fetchedAt: state.fetched_at, matched: state.matched }
}

export function robotsAllowsTradeValues(text: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = []
  let group = { agents: [] as string[], rules: [] as { allow: boolean; path: string }[] }
  for (const line of text.split(/\r?\n/)) {
    const [name, ...rest] = line.replace(/#.*/, '').split(':')
    const value = rest.join(':').trim()
    if (name.trim().toLowerCase() === 'user-agent') {
      if (group.rules.length) { groups.push(group); group = { agents: [], rules: [] } }
      group.agents.push(value.toLowerCase())
    } else if (['allow', 'disallow'].includes(name.trim().toLowerCase()) && value) {
      group.rules.push({ allow: name.trim().toLowerCase() === 'allow', path: value })
    }
  }
  groups.push(group)
  const specific = groups.filter(group => group.agents.some(agent => agent !== '*' && 'pancake'.includes(agent)))
  const matching = specific.length ? specific : groups.filter(group => group.agents.includes('*'))
  const rules = matching.flatMap(group => group.rules).filter(rule => {
    const pattern = rule.path.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*').replace(/\\\$$/, '$')
    return new RegExp(`^${pattern}`).test('/api/players')
  }).sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow))
  return rules[0]?.allow ?? true
}

class TradeValueFetchError extends Error {}

async function abortable<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort: () => void = () => {}
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

async function sourceText(url: string, fetcher: typeof fetch, signal: AbortSignal): Promise<string> {
  try {
    return await abortable(async () => {
      const response = await fetcher(url, { redirect: 'error', headers: { 'User-Agent': 'Pancake/1.0 (authorized daily value sync)' }, signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      if (text.length > 2_000_000) throw new Error('response exceeds the size limit')
      return text
    }, signal)
  } catch (error) {
    throw new TradeValueFetchError(`OneNumberHoops ${new URL(url).pathname} fetch failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function liveSource(fetcher: typeof fetch, signal: AbortSignal): Promise<string> {
  const robots = await sourceText('https://www.onenumberhoops.com/robots.txt', fetcher, AbortSignal.any([signal, AbortSignal.timeout(5_000)]))
  if (!robotsAllowsTradeValues(robots)) throw new Error('OneNumberHoops robots.txt blocks the value endpoint; use the CSV import')
  for (let attempt = 0; ; attempt++) {
    try {
      return await sourceText(TRADE_VALUE_URL, fetcher, AbortSignal.any([signal, AbortSignal.timeout(75_000)]))
    } catch (error) {
      if (attempt === 1 || signal.aborted) throw error
      await abortable(() => new Promise(resolve => setTimeout(resolve, 1_000)), signal)
    }
  }
}

export async function syncTradeValues(store: TradeValueStore, input: { format?: string; content?: string; retry?: number; retryDate?: string } = {}, fetcher: typeof fetch = fetch) {
  const mode = input.format ?? 'live'
  if (!['live', 'csv', 'json'].includes(mode)) throw new Error('Import format must be live, csv, or json')
  const retry = input.retry ?? 0
  if (!Number.isInteger(retry) || retry < 0 || retry > 4) throw new Error('Retry must be an integer from zero through four')
  if (input.retryDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.retryDate)) throw new Error('Retry date must use YYYY-MM-DD')
  const signal = AbortSignal.timeout(115_000)
  const sourceSignal = AbortSignal.any([signal, AbortSignal.timeout(110_000)])
  const requestId = mode === 'live' ? crypto.randomUUID() : null
  let claimed = false
  try {
    let content: string
    if (requestId) {
      claimed = await abortable(() => store.claim(requestId, signal), signal)
      if (!claimed) return { cached: true, snapshot: await abortable(() => store.cached(signal), signal) }
      content = await liveSource(fetcher, sourceSignal)
    } else {
      if (typeof input.content !== 'string' || input.content.length > 2_000_000) throw new Error('Import content is required and must be at most 2 MB')
      content = input.content
    }
    const values = mode === 'csv' ? parseTradeValuesCsv(content) : parseTradeValues(content)
    const players = await abortable(() => store.players(signal), signal)
    const overrides = await abortable(() => store.overrides(signal), signal)
    const matches = matchTradeValues(values, players, overrides)
    const rows = matches.map(row => ({ source_id: row.sourceId, name: row.name, team: row.team, positions: row.positions,
      rank: row.rank, value: row.value, age: row.age, player_id: row.playerId, reason: row.reason, candidate_ids: row.candidateIds }))
    const picks = values.filter(row => row.kind === 'pick').map(row => ({ year: row.year, round: row.round, tier: row.tier, value: row.value }))
    return await abortable(() => store.publish({ rows, picks, source: content, fetchedAt: new Date().toISOString(), mode, requestId }, signal), signal)
  } catch (error) {
    if (requestId && claimed) {
      const cleanupSignal = AbortSignal.timeout(5_000)
      try {
        await abortable(() => store.fail(requestId, retry, input.retryDate ?? null, error instanceof TradeValueFetchError, cleanupSignal), cleanupSignal)
      } catch (cleanupError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; retry cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
      }
    }
    throw error
  }
}
