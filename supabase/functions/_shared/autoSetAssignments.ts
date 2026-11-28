import { LINEUP_SLOT_ALLOWED_POSITIONS } from './lineupSlots.ts'
import type { AssignablePlayer } from './lineupAssignments.ts'

type Cost = number[]
const eligiblePositions: Partial<Record<string, readonly string[]>> = LINEUP_SLOT_ALLOWED_POSITIONS

function compare(a: Cost, b: Cost): number {
    for (let index = 0; index < a.length; index++) {
        const difference = a[index] - b[index]
        if (difference) return difference
    }
    return 0
}

function differenceInto(target: Cost, a: Cost, b: Cost): Cost {
    for (let index = 0; index < target.length; index++) target[index] = a[index] - b[index]
    return target
}

function subtractInto(target: Cost, b: Cost): Cost {
    for (let index = 0; index < target.length; index++) target[index] -= b[index]
    return target
}

function addInto(target: Cost, b: Cost): Cost {
    for (let index = 0; index < target.length; index++) target[index] += b[index]
    return target
}

function copyInto(target: Cost, source: Cost): Cost {
    for (let index = 0; index < target.length; index++) target[index] = source[index]
    return target
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
    const gameTimes = new Map<Player, number>()
    const gameTime = (player: Player) => {
        const cached = gameTimes.get(player)
        if (cached !== undefined) return cached
        const time = player.gameTime && hasGame(player) ? Date.parse(player.gameTime) : NaN
        const resolved = Number.isFinite(time) ? time : Infinity
        gameTimes.set(player, resolved)
        return resolved
    }
    const cutoffs = [...new Set(available.map(gameTime).filter(Number.isFinite))].sort((a, b) => a - b)
        .filter(time => available.some(player => hasGame(player) && !player.avoidInLineup && gameTime(player) > time))
    const futureOptions = new Map([...new Set(slots)].map(slot => [slot, cutoffs.map(time => available.filter(player =>
        !player.avoidInLineup && hasGame(player) && gameTime(player) > time
        && player.eligiblePositions.some(position => eligiblePositions[slot]?.includes(position))).length)]))
    const width = 9 + cutoffs.length * 2
    const zero: Cost = Array<number>(width).fill(0)
    const weights = (player: Player, slot: string): Cost => {
        const playing = !player.avoidInLineup && hasGame(player)
        const projected = Number.isFinite(player.projected) ? player.projected : 0
        const time = gameTime(player)
        const options = futureOptions.get(slot)!
        const flexibility = eligiblePositions[slot]?.length ?? 0
        const cost = Array<number>(width)
        cost[0] = -1
        cost[1] = player.lineupPin === 'bench' ? 1 : 0
        cost[2] = playing && player.lineupPin === 'start' ? -1 : 0
        cost[3] = playing ? -projected : 0
        cost[4] = playing ? -1 : 0
        for (let index = 0; index < cutoffs.length; index++) {
            const inside = time <= cutoffs[index]
            cost[5 + index * 2] = inside ? options[index] : 0
            cost[6 + index * 2] = inside ? flexibility : 0
        }
        const tail = 5 + cutoffs.length * 2
        cost[tail] = order.indexOf(slot)
        cost[tail + 1] = stored.get(player.playerId) === slot ? -1 : 0
        cost[tail + 2] = player.avoidInLineup ? 0 : -1
        cost[tail + 3] = -projected
        return cost
    }
    const rowCount = slots.length
    const columnCount = available.length + rowCount
    const rowPotential = Array.from({ length: rowCount + 1 }, () => Array<number>(width).fill(0))
    const columnPotential = Array.from({ length: columnCount + 1 }, () => Array<number>(width).fill(0))
    const matchedRow = Array<number>(columnCount + 1).fill(0)
    const previousColumn = Array<number>(columnCount + 1).fill(0)
    const costs = slots.map(slot => available.map(player =>
        player.eligiblePositions.some(position => eligiblePositions[slot]?.includes(position)) ? weights(player, slot) : null))
    const distanceRows = Array.from({ length: columnCount + 1 }, () => Array<number>(width).fill(0))
    const hasDistance = Array<boolean>(columnCount + 1).fill(false)
    const visited = Array<boolean>(columnCount + 1).fill(false)
    const scratch: Cost = Array<number>(width).fill(0)
    const deltaSnapshot: Cost = Array<number>(width).fill(0)

    for (let row = 1; row <= rowCount; row++) {
        matchedRow[0] = row
        hasDistance.fill(false)
        visited.fill(false)
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
                    differenceInto(scratch, cost, rowPotential[currentRow])
                    subtractInto(scratch, columnPotential[candidate])
                    if (!hasDistance[candidate] || compare(scratch, distanceRows[candidate]) < 0) {
                        copyInto(distanceRows[candidate], scratch)
                        hasDistance[candidate] = true
                        previousColumn[candidate] = column
                    }
                }
                const candidateDistance = hasDistance[candidate] ? distanceRows[candidate] : null
                if (candidateDistance && (!delta || compare(candidateDistance, delta) < 0)) {
                    delta = candidateDistance
                    nextColumn = candidate
                }
            }
            if (!delta) throw new Error('No lineup assignment is available')
            copyInto(deltaSnapshot, delta)
            for (let candidate = 0; candidate <= columnCount; candidate++) {
                if (visited[candidate]) {
                    addInto(rowPotential[matchedRow[candidate]], deltaSnapshot)
                    subtractInto(columnPotential[candidate], deltaSnapshot)
                } else if (hasDistance[candidate]) {
                    subtractInto(distanceRows[candidate], deltaSnapshot)
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
