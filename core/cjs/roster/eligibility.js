"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isIREligible = isIREligible;
exports.isDTD = isDTD;
exports.isTaxiEligible = isTaxiEligible;
function isIREligible(injuryStatus) {
    if (!injuryStatus)
        return false;
    const s = injuryStatus.toLowerCase();
    return s === 'out' || s.startsWith('ir');
}
function isDTD(injuryStatus) {
    if (!injuryStatus)
        return false;
    return injuryStatus.toLowerCase() === 'dtd';
}
function isTaxiEligible(nbaDraftNumber, yearsExp) {
    return nbaDraftNumber != null && yearsExp === 0;
}
