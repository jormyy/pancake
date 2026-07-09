"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LINEUP_SLOT_ALLOWED_POSITIONS = exports.LINEUP_SLOT_TYPES = exports.SLOT_TYPES = void 0;
exports.canPlayLineupSlot = canPlayLineupSlot;
exports.canOccupyRosterSlot = canOccupyRosterSlot;
const enums_1 = require("../types/enums");
exports.SLOT_TYPES = enums_1.ROSTER_SLOT_TYPES;
exports.LINEUP_SLOT_TYPES = enums_1.ROSTER_SLOT_TYPES.filter((slot) => slot !== 'IR');
exports.LINEUP_SLOT_ALLOWED_POSITIONS = {
    PG: ['PG'],
    SG: ['SG'],
    SF: ['SF'],
    PF: ['PF'],
    C: ['C'],
    G: ['PG', 'SG'],
    F: ['SF', 'PF'],
    UTIL: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'],
    BE: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'],
};
function normalizedPositions(position, eligiblePositions) {
    return eligiblePositions.length > 0 ? [...eligiblePositions]
        : position ? [position] : [];
}
function canPlayLineupSlot(position, eligiblePositions, slotType) {
    if (!Object.hasOwn(exports.LINEUP_SLOT_ALLOWED_POSITIONS, slotType))
        return false;
    const allPositions = normalizedPositions(position, eligiblePositions);
    if (allPositions.length === 0)
        return false;
    const allowedPositions = exports.LINEUP_SLOT_ALLOWED_POSITIONS[slotType];
    return allPositions.some((position) => allowedPositions.includes(position));
}
function canOccupyRosterSlot(position, eligiblePositions, slotType) {
    if (slotType === 'IR')
        return true;
    return canPlayLineupSlot(position, eligiblePositions, slotType);
}
