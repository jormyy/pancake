"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRosterFull = isRosterFull;
exports.hasTaxiSpace = hasTaxiSpace;
function isRosterFull(activeCount, rosterSize) {
    return activeCount >= rosterSize;
}
function hasTaxiSpace(taxiCount, taxiSlots) {
    return taxiCount < taxiSlots;
}
