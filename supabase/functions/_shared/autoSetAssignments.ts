import { LINEUP_SLOT_ALLOWED_POSITIONS } from './lineupSlots.ts'
import type { AssignablePlayer } from './lineupAssignments.ts'

type Cost = readonly number[]
const eligiblePositions: Partial<Record<string, readonly string[]>> = LINEUP_SLOT_ALLOWED_POSITIONS

function subtract(a: Cost, b: Cost): Cost {
    return a.map((value, index) => value - b[index])
}

function add(a: Cost, b: Cost): Cost {
    return a.map((value, index) => value + b[index])
}

function compare(a: Cost, b: Cost): number {
    for (let index = 0; index < a.length; index++) {
        const difference = a[index] - b[index]
        if (difference) return difference
    }
    return 0
}

export function chooseAutoSetAssignments<Player extends AssignablePlayer & { gameTime?: string | null; lineupPin?: 'start' | 'bench' | null }>(
    slots: string[],
    players: Player[],
    hasGame: (player: Player) => boolean,
    current: { playerId: string; slotType: string }[] = [],
): { playerId: string; slotType: string }[] {
    const order = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL']
    slots = [...slots].sort((a, b) => order.indexOf(a) - order.indexOf(b))
    const available = [...players].sort((a, b) => a.playerId.localeCompare(b.playerId))
    const stored = new Map(current.map(entry => [entry.playerId, entry.slotType]))
    const gameTime = (player: Player) => {
        const time = player.gameTime && hasGame(player) ? Date.parse(player.gameTime) : NaN
        return Number.isFinite(time) ? time : Infinity
    }
    const cutoffs = [...new Set(available.map(gameTime).filter(Number.isFinite))].sort((a, b) => a - b)
        .filter(time => available.some(player => hasGame(player) && !player.avoidInLineup && gameTime(player) > time))
    const futureOptions = new Map([...new Set(slots)].map(slot => [slot, cutoffs.map(time => available.filter(player =>
        !player.avoidInLineup && hasGame(player) && gameTime(player) > time
        && player.eligiblePositions.some(position => eligiblePositions[slot]?.includes(position))).length)]))
    const zero: Cost = Array<number>(9 + cutoffs.length * 2).fill(0)
    const weights = (player: Player, slot: string): Cost => {
        const playing = !player.avoidInLineup && hasGame(player)
        const projected = Number.isFinite(player.projected) ? player.projected : 0
        const flexibility = cutoffs.flatMap((time, index) => gameTime(player) <= time
            ? [futureOptions.get(slot)![index], eligiblePositions[slot]?.length ?? 0] : [0, 0])
        return [-1, player.lineupPin === 'bench' ? 1 : 0, playing && player.lineupPin === 'start' ? -1 : 0, playing ? -projected : 0, playing ? -1 : 0, ...flexibility, order.indexOf(slot),
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
