import { describe, expect, it } from 'vitest'
import { pickAgeFactor, predictedPickValue, predictPickFinishes, projectedPickStrength } from '../supabase/functions/_shared/pickPredictions'

const teams = [
  { id: 'a', wins: 1, ties: 0, players: [{ value: 100 * (8 + Math.log(3)) / (8 - Math.log(3)), age: 27 }] },
  { id: 'b', wins: 0, ties: 0, players: [{ value: 100, age: 27 }] },
]
const games = [{ home: 'a', away: 'b' }]

describe('closed-form pick predictions', () => {
  it('matches the hand calculation with a three-to-one win probability', () => {
    const result = predictPickFinishes(teams, games)
    expect(result[0].expectedWins).toBeCloseTo(1.75, 12)
    expect(result[1].expectedWins).toBeCloseTo(0.25, 12)
    expect(result[0].variance).toBeCloseTo(0.1875, 12)
    expect(result[0].odds.early).toBeCloseTo(0.00475015227808151, 6)
    expect(result[0].odds.late).toBeCloseTo(0.8080126664257654, 6)
    expect(result[0].odds.late).toBeGreaterThan(0.8)
    expect(result[1].odds.early).toBeGreaterThan(0.8)
  })

  it('gives the strongest roster late odds and the weakest roster early odds before any results', () => {
    const league = Array.from({ length: 12 }, (_, index) => ({ id: String(index), wins: 0, ties: 0,
      players: [{ value: index === 0 ? 800 : index === 11 ? 50 : 300, age: 27 }] }))
    const schedule = league.flatMap((home, index) => league.slice(index + 1).map(away => ({ home: home.id, away: away.id })))
    const result = predictPickFinishes(league, schedule)
    expect(result[0].odds.late).toBeGreaterThan(0.9)
    expect(result[11].odds.early).toBeGreaterThan(0.9)
  })

  it('bounds every blend and makes distant picks lean toward the middle', () => {
    for (const years of [0, 1, 2, 5]) {
      for (const result of predictPickFinishes(teams, games, years)) {
        expect(result.odds.early + result.odds.mid + result.odds.late).toBeCloseTo(1, 12)
        const value = predictedPickValue(result.odds, { early: 700, mid: 500, late: 300 })
        expect(value).toBeGreaterThanOrEqual(300)
        expect(value).toBeLessThanOrEqual(700)
        if (years === 5) expect(result.odds.mid).toBeGreaterThan(0.9)
      }
    }
    expect(predictPickFinishes(teams, games)).toEqual(predictPickFinishes(teams, games))
  })

  it('uses roster depth and age without random draws', () => {
    expect(projectedPickStrength(Array.from({ length: 20 }, () => ({ value: 100, age: 27 })))).toBe(1300)
    expect(pickAgeFactor(24)).toBeGreaterThan(pickAgeFactor(18))
    expect(pickAgeFactor(27)).toBeGreaterThan(pickAgeFactor(24))
    expect(pickAgeFactor(35)).toBeLessThan(pickAgeFactor(29))
    expect(predictPickFinishes([], [])).toEqual([])
    expect(() => predictedPickValue({ early: 1, mid: 1, late: 0 }, { early: 700, mid: 500, late: 300 })).toThrow('sum to one')
  })
})
