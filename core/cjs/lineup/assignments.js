"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chooseBestAssignments = chooseBestAssignments;
const lineupSlots_1 = require("../positions/lineupSlots");
const zero = [0, 0, 0, 0];
const eligiblePositions = lineupSlots_1.LINEUP_SLOT_ALLOWED_POSITIONS;
function subtract(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
}
function add(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
}
function compare(a, b) {
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
}
function chooseBestAssignments(slots, players, hasGame, objective = 'filled') {
    const available = objective === 'projection' ? players.filter(player => !player.avoidInLineup && hasGame(player)) : players;
    const weights = available.map(player => objective === 'filled'
        ? [-1, player.avoidInLineup ? 0 : -1, hasGame(player) ? -1 : 0, -player.projected]
        : [-player.projected, -1, 0, 0]);
    const rowCount = slots.length;
    const columnCount = available.length + rowCount;
    const rowPotential = Array(rowCount + 1).fill(zero);
    const columnPotential = Array(columnCount + 1).fill(zero);
    const matchedRow = Array(columnCount + 1).fill(0);
    const previousColumn = Array(columnCount + 1).fill(0);
    const costs = slots.map(slot => available.map((player, index) => player.eligiblePositions.some(position => eligiblePositions[slot]?.includes(position)) ? weights[index] : null));
    for (let row = 1; row <= rowCount; row++) {
        matchedRow[0] = row;
        const distance = Array(columnCount + 1).fill(null);
        const visited = Array(columnCount + 1).fill(false);
        let column = 0;
        do {
            visited[column] = true;
            const currentRow = matchedRow[column];
            let delta = null;
            let nextColumn = 0;
            for (let candidate = 1; candidate <= columnCount; candidate++) {
                if (visited[candidate])
                    continue;
                const cost = candidate <= available.length ? costs[currentRow - 1][candidate - 1] : zero;
                if (cost) {
                    const reducedCost = subtract(subtract(cost, rowPotential[currentRow]), columnPotential[candidate]);
                    const previousDistance = distance[candidate];
                    if (!previousDistance || compare(reducedCost, previousDistance) < 0) {
                        distance[candidate] = reducedCost;
                        previousColumn[candidate] = column;
                    }
                }
                const candidateDistance = distance[candidate];
                if (candidateDistance && (!delta || compare(candidateDistance, delta) < 0)) {
                    delta = candidateDistance;
                    nextColumn = candidate;
                }
            }
            if (!delta)
                throw new Error('No lineup assignment is available');
            for (let candidate = 0; candidate <= columnCount; candidate++) {
                if (visited[candidate]) {
                    rowPotential[matchedRow[candidate]] = add(rowPotential[matchedRow[candidate]], delta);
                    columnPotential[candidate] = subtract(columnPotential[candidate], delta);
                }
                else {
                    const previousDistance = distance[candidate];
                    if (previousDistance)
                        distance[candidate] = subtract(previousDistance, delta);
                }
            }
            column = nextColumn;
        } while (matchedRow[column] !== 0);
        do {
            const previous = previousColumn[column];
            matchedRow[column] = matchedRow[previous];
            column = previous;
        } while (column !== 0);
    }
    return matchedRow.flatMap((row, column) => row > 0 && column > 0 && column <= available.length
        ? [{ playerId: available[column - 1].playerId, slotType: slots[row - 1] }] : []);
}
