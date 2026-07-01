import { calculateProjectionFantasyPoints } from './scoring.ts'

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

Deno.test('calculates FantasyPros projection fantasy points with league scoring settings', () => {
  const total = calculateProjectionFantasyPoints(
    {
      points: 25,
      rebounds: 10,
      assists: 5,
      steals: 2,
      blocks: 1,
      three_pointers_made: 3,
      turnovers: 4,
    },
    {
      points: 1,
      rebounds: 1.25,
      assists: 1.5,
      steals: 3,
      blocks: 3,
      three_pointers_made: 0.5,
      turnovers: -1,
      field_goals_made: 0,
      field_goals_attempted: 0,
      free_throws_made: 0,
      free_throws_attempted: 0,
      double_double: 0,
      triple_double: 0,
    },
  )

  expect(total === 51.5, `expected 51.5 fantasy points, got ${total}`)
})

Deno.test('treats missing projection stats as zero and rounds to two decimals', () => {
  const total = calculateProjectionFantasyPoints(
    {
      points: 10.126,
      rebounds: null,
      assists: 1,
      steals: null,
      blocks: null,
      three_pointers_made: 2,
      turnovers: null,
    },
    {
      points: 1,
      rebounds: 1,
      assists: 1.333,
      steals: 3,
      blocks: 3,
      three_pointers_made: 0.5,
      turnovers: -1,
    },
  )

  expect(total === 12.46, `expected rounded total 12.46, got ${total}`)
})
