"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_TRADE_FAAB_AMOUNT = exports.MAX_TRADE_PARTICIPANTS = exports.MAX_TRADE_NOTES_BYTES = exports.MAX_TRADE_EXPIRATION_DAYS = exports.MAX_TRADE_ITEMS = void 0;
exports.utf8ByteLength = utf8ByteLength;
exports.MAX_TRADE_ITEMS = 100;
exports.MAX_TRADE_EXPIRATION_DAYS = 30;
exports.MAX_TRADE_NOTES_BYTES = 2_000;
exports.MAX_TRADE_PARTICIPANTS = 12;
exports.MAX_TRADE_FAAB_AMOUNT = 1_000_000;
function utf8ByteLength(value) {
    let bytes = 0;
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint <= 0x7f)
            bytes += 1;
        else if (codePoint <= 0x7ff)
            bytes += 2;
        else if (codePoint <= 0xffff)
            bytes += 3;
        else
            bytes += 4;
    }
    return bytes;
}
