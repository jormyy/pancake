"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SLOT_TYPES = void 0;
exports.canPlaySlot = canPlaySlot;
exports.SLOT_TYPES = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE', 'IR'];
const POSITION_GROUPS = {
    G: ['PG', 'SG'],
    F: ['SF', 'PF'],
};
function canPlaySlot(position, eligiblePositions, slotType) {
    if (slotType === 'UTIL' || slotType === 'BE' || slotType === 'IR')
        return true;
    const allPositions = eligiblePositions.length > 0 ? eligiblePositions
        : position ? [position] : [];
    if (allPositions.length === 0)
        return false;
    const group = POSITION_GROUPS[slotType];
    if (group)
        return allPositions.some((p) => group.includes(p));
    return allPositions.includes(slotType);
}
