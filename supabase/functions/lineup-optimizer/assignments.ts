import { SLOT_ALLOWED_POSITIONS as SLOT_ELIGIBLE } from '../_shared/scoreLineups.ts'

export type AssignablePlayer = {
  playerId: string
  eligiblePositions: string[]
  projected: number
  avoidInLineup: boolean
}

type AssignmentScore = {
  filled: number
  healthy: number
  game: number
  projected: number
}
type AssignmentResult = {
  assignments: { playerId: string; slotType: string }[]
  score: AssignmentScore
}

function emptyScore(): AssignmentScore {
  return { filled: 0, healthy: 0, game: 0, projected: 0 }
}

function addScore(score: AssignmentScore, player: AssignablePlayer, hasGame: boolean): AssignmentScore {
  return {
    filled: score.filled + 1,
    healthy: score.healthy + (player.avoidInLineup ? 0 : 1),
    game: score.game + (hasGame ? 1 : 0),
    projected: score.projected + player.projected,
  }
}

function compareScore(a: AssignmentScore, b: AssignmentScore): number {
  return a.filled - b.filled || a.healthy - b.healthy || a.game - b.game || a.projected - b.projected
}

// The used-player set is a BigInt bitmask: a Number loses exact bits at index
// 53, which let a 54-player roster reuse player 0 in a second slot.
export function chooseBestAssignments<Player extends AssignablePlayer>(
  slots: string[],
  players: Player[],
  hasGame: (player: Player) => boolean,
  objective: 'filled' | 'projection' = 'filled',
): { playerId: string; slotType: string }[] {
  if (objective === 'projection') return chooseProjectedAssignments(slots, players.filter((player) => !player.avoidInLineup && hasGame(player)))
  const memo = new Map<string, AssignmentResult>()
  const bits = players.map((_, index) => 1n << BigInt(index))

  function search(slotIndex: number, mask: bigint): AssignmentResult {
    if (slotIndex >= slots.length) return { assignments: [], score: emptyScore() }
    const key = `${slotIndex}:${mask}`
    const cached = memo.get(key)
    if (cached) return cached

    let best = search(slotIndex + 1, mask)
    const slotType = slots[slotIndex]
    const eligible = SLOT_ELIGIBLE[slotType] ?? []
    for (let playerIndex = 0; playerIndex < players.length; playerIndex++) {
      if ((mask & bits[playerIndex]) !== 0n) continue
      const player = players[playerIndex]
      if (!player.eligiblePositions.some((position) => eligible.includes(position))) continue

      const next = search(slotIndex + 1, mask | bits[playerIndex])
      const candidate: AssignmentResult = {
        assignments: [{ playerId: player.playerId, slotType }, ...next.assignments],
        score: addScore(next.score, player, hasGame(player)),
      }
      if (compareScore(candidate.score, best.score) > 0) best = candidate
    }

    memo.set(key, best)
    return best
  }

  return search(0, 0n).assignments
}


function chooseProjectedAssignments(slots: string[], players: AssignablePlayer[]) {
  const rowCount = slots.length
  const columnCount = players.length + rowCount
  const rowPotential = Array<number>(rowCount + 1).fill(0)
  const columnPotential = Array<number>(columnCount + 1).fill(0)
  const matchedRow = Array<number>(columnCount + 1).fill(0)
  const previousColumn = Array<number>(columnCount + 1).fill(0)
  const costs = slots.map((slot) => players.map((player) =>
    player.eligiblePositions.some((position) => (SLOT_ELIGIBLE[slot] ?? []).includes(position))
      ? -player.projected : Infinity))

  for (let row = 1; row <= rowCount; row++) {
    matchedRow[0] = row
    const distance = Array<number>(columnCount + 1).fill(Infinity)
    const visited = Array<boolean>(columnCount + 1).fill(false)
    let column = 0
    do {
      visited[column] = true
      const currentRow = matchedRow[column]
      let delta = Infinity
      let nextColumn = 0
      for (let candidate = 1; candidate <= columnCount; candidate++) {
        if (visited[candidate]) continue
        const cost = candidate <= players.length ? costs[currentRow - 1][candidate - 1] : 0
        const reducedCost = cost - rowPotential[currentRow] - columnPotential[candidate]
        if (reducedCost < distance[candidate]) {
          distance[candidate] = reducedCost
          previousColumn[candidate] = column
        }
        if (distance[candidate] < delta) {
          delta = distance[candidate]
          nextColumn = candidate
        }
      }
      for (let candidate = 0; candidate <= columnCount; candidate++) {
        if (visited[candidate]) {
          rowPotential[matchedRow[candidate]] += delta
          columnPotential[candidate] -= delta
        } else distance[candidate] -= delta
      }
      column = nextColumn
    } while (matchedRow[column] !== 0)
    do {
      const previous = previousColumn[column]
      matchedRow[column] = matchedRow[previous]
      column = previous
    } while (column !== 0)
  }

  return matchedRow.flatMap((row, column) => row > 0 && column > 0 && column <= players.length
    ? [{ playerId: players[column - 1].playerId, slotType: slots[row - 1] }] : [])
}
