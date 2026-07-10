export const MAX_TRADE_ITEMS = 100
export const MAX_TRADE_EXPIRATION_DAYS = 30
export const MAX_TRADE_NOTES_BYTES = 2_000
export const MAX_TRADE_PARTICIPANTS = 12

export function utf8ByteLength(value: string): number {
    let bytes = 0
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0
        if (codePoint <= 0x7f) bytes += 1
        else if (codePoint <= 0x7ff) bytes += 2
        else if (codePoint <= 0xffff) bytes += 3
        else bytes += 4
    }
    return bytes
}
