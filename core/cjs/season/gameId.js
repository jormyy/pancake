"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRegularSeasonGameId = isRegularSeasonGameId;
function isRegularSeasonGameId(gameId) {
    const id = gameId?.trim();
    if (!id)
        return false;
    if (id.startsWith('002'))
        return true;
    if (/^00\d/.test(id))
        return false;
    return true;
}
