import { LINEUP_SLOT_ALLOWED_POSITIONS } from './lineupSlots.ts'
import type { AssignablePlayer } from './lineupAssignments.ts'

type Cost = readonly [number, number, number, number, number, number, number]
const zero: Cost = [0, 0, 0, 0, 0, 0, 0]
const eligiblePositions: Partial<Record<string, readonly string[]>> = LINEUP_SLOT_ALLOWED_POSITIONS

function subtract(a: Cost, b: Cost): Cost {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3], a[4] - b[4], a[5] - b[5], a[6] - b[6]]
}

function add(a: Cost, b: Cost): Cost {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3], a[4] + b[4], a[5] + b[5], a[6] + b[6]]
}

function compare(a: Cost, b: Cost): number {
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3] || a[4] - b[4] || a[5] - b[5] || a[6] - b[6]
}

export function chooseAutoSetAssignments<Player extends AssignablePlayer>(
    slots: string[],
    players: Player[],
    hasGame: (player: Player) => boolean,
    current: { playerId: string; slotType: string }[] = [],
): { playerId: string; slotType: string }[] {
    const order = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL']
    slots = [...slots].sort((a, b) => order.indexOf(a) - order.indexOf(b))
    const available = [...players].sort((a, b) => a.playerId.localeCompare(b.playerId))
    const stored = new Map(current.map(entry => [entry.playerId, entry.slotType]))
    const weights = (player: Player, slot: string): Cost => {
        const playing = !player.avoidInLineup && hasGame(player)
        const projected = Number.isFinite(player.projected) ? player.projected : 0
        return [-1, playing ? -projected : 0, playing ? -1 : 0, order.indexOf(slot),
            stored.get(player.playerId) === slot ? -1 : 0, player.avoidInLineup ? 0 : -1, -projected]
    }
    const rowCount = slots.length
    const columnCount = available.length + rowCount
    const rowPotential = Array<Cost>(rowCount + 1).fill(zero)
    const columnPotential = Array<Cost>(columnCount + 1).fill(zero)
    const matchedRow = Array<number>(columnCount + 1).fill(0)
    const previousColumn = Array<number>(columnCount + 1).fill(0)
    const costs = slots.map(slot => available.map(player =>
        player.eligiblePositions.some(position => eligiblePositions[slot]?.includes(position)) ? weights(player, slot) : null))

    for (let row = 1; row <= rowCount; row++) {
        matchedRow[0] = row
        const distance = Array<Cost | null>(columnCount + 1).fill(null)
        const visited = Array<boolean>(columnCount + 1).fill(false)
        let column = 0
        do {
            visited[column] = true
            const currentRow = matchedRow[column]
            let delta: Cost | null = null
            let nextColumn = 0
            for (let candidate = 1; candidate <= columnCount; candidate++) {
                if (visited[candidate]) continue
                const cost = candidate <= available.length ? costs[currentRow - 1][candidate - 1] : zero
                if (cost) {
                    const reducedCost = subtract(subtract(cost, rowPotential[currentRow]), columnPotential[candidate])
                    const previousDistance = distance[candidate]
                    if (!previousDistance || compare(reducedCost, previousDistance) < 0) {
                        distance[candidate] = reducedCost
                        previousColumn[candidate] = column
                    }
                }
                const candidateDistance = distance[candidate]
                if (candidateDistance && (!delta || compare(candidateDistance, delta) < 0)) {
                    delta = candidateDistance
                    nextColumn = candidate
                }
            }
            if (!delta) throw new Error('No lineup assignment is available')
            for (let candidate = 0; candidate <= columnCount; candidate++) {
                if (visited[candidate]) {
                    rowPotential[matchedRow[candidate]] = add(rowPotential[matchedRow[candidate]], delta)
                    columnPotential[candidate] = subtract(columnPotential[candidate], delta)
                } else {
                    const previousDistance = distance[candidate]
                    if (previousDistance) distance[candidate] = subtract(previousDistance, delta)
                }
            }
            column = nextColumn
        } while (matchedRow[column] !== 0)
        do {
            const previous = previousColumn[column]
            matchedRow[column] = matchedRow[previous]
            column = previous
        } while (column !== 0)
    }

    return matchedRow.flatMap((row, column) => row > 0 && column > 0 && column <= available.length
        ? [{ playerId: available[column - 1].playerId, slotType: slots[row - 1] }] : [])
}
