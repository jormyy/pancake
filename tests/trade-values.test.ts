import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { matchTradeValues, normalizeTradeValueName, parseTradeValues, parseTradeValuesCsv, thirdRoundTradeValue, type TradeValuePlayer } from '../supabase/functions/_shared/tradeValues'

const source = readFileSync('tests/fixtures/trade-values/onenumberhoops.json', 'utf8')
const rows = parseTradeValues(source)
const mutate = (change: (data: Record<string, unknown>[]) => void) => {
  const response = JSON.parse(source)
  change(response.data)
  return JSON.stringify(response)
}

describe('OneNumberHoops source contract', () => {
  it('attests the exact response captured by the live worker', () => {
    const record = JSON.parse(readFileSync('tests/fixtures/trade-values/source.json', 'utf8'))
    expect(createHash('sha256').update(source).digest('hex')).toBe(record.sha256)
    expect(record.url).toBe('https://www.onenumberhoops.com/api/players')
    expect(Number.isFinite(Date.parse(record.fetchedAt))).toBe(true)
  })
  it('reads the recorded 450 players and complete 18-pick grid without fetching', () => {
    expect(rows.filter(row => row.kind === 'player')).toHaveLength(450)
    expect(rows.filter(row => row.kind === 'pick')).toHaveLength(18)
    expect(rows[0]).toMatchObject({ name: 'Victor Wembanyama', rawValue: 9999, value: 999.9 })
    expect(rows.find(row => row.name === '2029 Early 1st Round Pick')?.year).toBe(2029)
  })
  it.each([
    ['partial response', (data: Record<string, unknown>[]) => { data.pop() }],
    ['renamed value', (data: Record<string, unknown>[]) => { data[0].score = data[0].value; delete data[0].value }],
    ['string value', (data: Record<string, unknown>[]) => { data[0].value = '9999' }],
    ['duplicate identity', (data: Record<string, unknown>[]) => { data[1].id = data[0].id }],
    ['duplicate rank', (data: Record<string, unknown>[]) => { data[1].rank = data[0].rank }],
    ['invalid position', (data: Record<string, unknown>[]) => { data[0].pos = 'FUTURE' }],
    ['invalid pick grid', (data: Record<string, unknown>[]) => { const pick = data.find(row => row.player === '2029 Early 1st Round Pick')!; pick.player = '2031 Early 1st Round Pick' }],
  ])('fails loudly on %s', (_, change) => {
    expect(() => parseTradeValues(mutate(change))).toThrow('OneNumberHoops contract:')
  })
  it('rejects HTML, failed responses, and missing envelopes', () => {
    for (const bad of ['<html>Blocked</html>', '{"success":false,"data":[]}', '[]']) expect(() => parseTradeValues(bad)).toThrow('contract:')
  })
  it('uses the same contract for CSV', () => {
    const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
    const csv = ['source_id,name,team,positions,rank,value,age', ...rows.map(row => [row.sourceId, row.name, row.team, row.positions.join('/'), row.rank, row.rawValue, row.age].map(quote).join(','))].join('\r\n')
    expect(parseTradeValuesCsv(csv)).toEqual(rows)
    expect(() => parseTradeValuesCsv(csv.replace('source_id', 'id'))).toThrow('CSV header')
    expect(() => parseTradeValuesCsv(`${csv}\n"unfinished`)).toThrow('CSV quote')
    expect(() => parseTradeValuesCsv(csv.replace('"Victor Wembanyama"', '"Victor" Wembanyama'))).toThrow('CSV quote')
  })
})

describe('trade value identity matching', () => {
  const player = (id: string, name: string, team = 'DEN', position = 'C'): TradeValuePlayer => ({ id, display_name: name, nba_team: team, position, eligible_positions: [position] })
  const value = { ...rows[0], name: 'Nikola Jokić Jr.', team: 'DEN', positions: ['C'] }
  it('matches at least 98 percent of the production-shaped fixture and lists every unresolved name', () => {
    const players = JSON.parse(readFileSync('tests/fixtures/trade-values/pancake-players.json', 'utf8')) as TradeValuePlayer[]
    const matches = matchTradeValues(rows, players)
    expect(matches).toHaveLength(450)
    expect(matches.filter(row => row.playerId).length / matches.length).toBeGreaterThanOrEqual(0.98)
    expect(matches.filter(row => !row.playerId).map(row => row.name)).toEqual([
      'Alex Caruso', 'Jamaree Bouyea', 'Vince Williams Jr.', 'Alex Toohey', 'Lonzo Ball',
    ])
  })
  it('normalizes accents, suffixes, punctuation, and aliases', () => {
    expect(normalizeTradeValueName('Nikola Jokić Jr.')).toBe('nikola jokic')
    expect(matchTradeValues([value], [player('one', 'Nikola Jokic')])[0].playerId).toBe('one')
    expect(matchTradeValues([{ ...value, name: 'Nicolas Claxton', team: 'BRK' }], [player('two', 'Nic Claxton', 'BKN')])[0].playerId).toBe('two')
  })
  it('uses team and position to resolve names and refuses ambiguity', () => {
    const duplicate = [player('one', 'Nikola Jokic'), player('two', 'Nikola Jokic', 'LAL')]
    expect(matchTradeValues([value], duplicate)[0].playerId).toBe('one')
    expect(matchTradeValues([{ ...value, team: 'MIA' }], duplicate)[0].playerId).toBeNull()
    expect(matchTradeValues([value], [player('one', 'Nikola Jokic', 'DEN', 'PG')])[0].playerId).toBeNull()
  })
  it('allows a unique name and compatible position after a team change', () => {
    expect(matchTradeValues([value], [player('one', 'Nikola Jokic', 'LAL')])[0]).toMatchObject({ playerId: 'one', reason: 'name-position' })
  })
  it('uses reviewed identities without assigning one player twice', () => {
    const values = [value, { ...value, sourceId: 'other', name: 'Unknown Player' }]
    const result = matchTradeValues(values, [player('one', 'Nikola Jokic')], { other: 'one' })
    expect(result.map(row => row.playerId)).toEqual(['one', null])
  })
  it('applies the third-round percentage and league replacement floor', () => {
    expect(thirdRoundTradeValue(302.8, 180)).toBe(180)
    expect(thirdRoundTradeValue(600, 180)).toBe(240)
    expect(thirdRoundTradeValue(302.8, 50)).toBe(121.12)
    expect(() => thirdRoundTradeValue(NaN, 180)).toThrow()
  })
})
