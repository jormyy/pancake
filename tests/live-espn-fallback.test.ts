import { readFileSync, readdirSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const modulePath = '../supabase/functions/live-poll/espn.ts'
const root = 'tests/fixtures/live-espn/'
const files = readdirSync(root).sort()
const fixture = (name: string) => JSON.parse(readFileSync(root + files.find(file => file.includes(name)), 'utf8'))
let source: Awaited<ReturnType<typeof importSource>>
const importSource = () => import(/* @vite-ignore */ modulePath)

beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => undefined } })
  source = await importSource()
})
afterAll(() => vi.unstubAllGlobals())

describe('recorded live ESPN data', () => {
  it.each(['401909893', '401909894'])('maps all playing athletes and keeps %s live', id => {
    const board = fixture('-scoreboard.json').payload
    const event = board.events.find((event: { id: string }) => event.id === id)
    const summary = JSON.parse(readFileSync(root + files.find(file => file.includes('01-00-49') && file.includes(`summary-${id}`)), 'utf8')).payload
    const parsed = source.parseEspnSummary(summary, event)
    expect(parsed.game.gameStatus).toBe(2)
    expect(parsed.players.length).toBeGreaterThan(10)
    expect(new Set(parsed.players.map((row: { espnId: string }) => row.espnId)).size).toBe(parsed.players.length)
    expect(parsed.sourceUpdatedAt).toBe(summary.meta.lastUpdatedAt)
  })

  it('rejects a real header that is ahead of the player box', () => {
    const event = fixture('-scoreboard.json').payload.events[0]
    expect(() => source.parseEspnSummary(fixture(`summary-${event.id}`).payload, event)).toThrow('incomplete team points')
  })

  it.each([['0.0', 'PT0M00.0S'], ['40.7', 'PT0M40.7S'], ['3:12', 'PT3M12S']])('accepts ESPN clock %s', (clock, expected) => {
    const event = fixture('-scoreboard.json').payload.events[0]
    const summary = JSON.parse(readFileSync(root + files.find(file => file.includes('01-00-49') && file.includes(`summary-${event.id}`)), 'utf8')).payload
    summary.header.competitions[0].status.displayClock = clock
    expect(source.parseEspnSummary(summary, event).game.gameClock).toBe(expected)
  })

  it('maps games by ET date, season and ordered normalized sides', () => {
    const events = fixture('-scoreboard.json').payload.events
    const game = { game_date: '2026-10-29', season_year: 2027, home_team: 'NOP', away_team: 'SAC' }
    expect(source.matchEspnGame(game, events)?.id).toBe('401909894')
    expect(source.matchEspnGame({ ...game, game_date: '2026-10-30' }, events)).toBeUndefined()
    expect(source.matchEspnGame({ ...game, season_year: 2026 }, events)).toBeUndefined()
    expect(() => source.matchEspnGame(game, [...events, ...events])).toThrow('Ambiguous')
  })

  it('uses the strict 90-second threshold and preserves fresh NBA corrections', () => {
    const event = fixture('-scoreboard.json').payload.events[0]
    const summary = JSON.parse(readFileSync(root + files.find(file => file.includes('01-00-49') && file.includes(`summary-${event.id}`)), 'utf8')).payload
    const espn = source.parseEspnSummary(summary, event).game
    const now = Date.parse('2026-10-30T01:00:00Z')
    const nba = { ...espn, homeTeam: { ...espn.homeTeam, score: espn.homeTeam.score - 2 }, sourceUpdatedAt: new Date(now - 90_000).toISOString() }
    expect(source.fallbackReason(nba, espn, now)).toBeNull()
    expect(source.fallbackReason({ ...nba, sourceUpdatedAt: new Date(now - 90_001).toISOString() }, espn, now)).toBe('nba-source-age')
    expect(source.fallbackReason(undefined, espn, now)).toBe('nba-unavailable')
    expect(source.fallbackReason({ ...nba, gameStatus: 3 }, espn, now)).toBeNull()
  })

  it.each(['identity', 'timestamp', 'points', 'columns', 'duplicates', 'count range', 'shot range'])('rejects incomplete or inconsistent %s', fault => {
    const board = fixture('-scoreboard.json').payload
    const event = board.events[0]
    const summary = JSON.parse(readFileSync(root + files.find(file => file.includes('01-00-49') && file.includes(`summary-${event.id}`)), 'utf8')).payload
    if (fault === 'count range') summary.boxscore.players[0].statistics[0].athletes[0].stats[6] = '2147483648'
    if (fault === 'shot range') summary.boxscore.players[0].statistics[0].athletes[0].stats[2] = '0-2147483648'
    if (fault === 'identity') summary.header.id = 'wrong'
    if (fault === 'timestamp') delete summary.meta.lastUpdatedAt
    if (fault === 'points') summary.boxscore.players[0].statistics[0].athletes[0].stats[1] = '999'
    if (fault === 'columns') summary.boxscore.players[0].statistics[0].names[0] = 'wrong'
    if (fault === 'duplicates') summary.boxscore.players[0].statistics[0].athletes[1].athlete.id = summary.boxscore.players[0].statistics[0].athletes[0].athlete.id
    expect(() => source.parseEspnSummary(summary, event)).toThrow()
  })
})
