"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LINEUP_SLOT_TYPES = exports.SLOT_TYPES = exports.LINEUP_SLOT_ALLOWED_POSITIONS = void 0;
exports.canPlayLineupSlot = canPlayLineupSlot;
const enums_1 = require("../types/enums");
const lineupSlots_1 = require("./lineupSlots");
var lineupSlots_2 = require("./lineupSlots");
Object.defineProperty(exports, "LINEUP_SLOT_ALLOWED_POSITIONS", { enumerable: true, get: function () { return lineupSlots_2.LINEUP_SLOT_ALLOWED_POSITIONS; } });
exports.SLOT_TYPES = enums_1.ROSTER_SLOT_TYPES;
exports.LINEUP_SLOT_TYPES = enums_1.ROSTER_SLOT_TYPES.filter((slot) => slot !== 'IR');
function normalizedPositions(position, eligiblePositions) {
    return eligiblePositions.length > 0 ? [...eligiblePositions]
        : position ? [position] : [];
}
function canPlayLineupSlot(position, eligiblePositions, slotType) {
    if (!Object.hasOwn(lineupSlots_1.LINEUP_SLOT_ALLOWED_POSITIONS, slotType))
        return false;
    const allPositions = normalizedPositions(position, eligiblePositions);
    if (allPositions.length === 0)
        return false;
    const allowedPositions = lineupSlots_1.LINEUP_SLOT_ALLOWED_POSITIONS[slotType];
    return allPositions.some((position) => allowedPositions.includes(position));
}
