const MAX_CHARS = 14

/** "Shai Gilgeous-Alexander" → "S. Gilgeous…": first initial always kept, long names end in an ellipsis. */
export function compactPlayerName(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean)
    if (parts.length > 1 && /^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(parts.at(-1)!)) parts.pop()
    const surname = parts.at(-1) ?? ''
    const full = parts.length < 2 ? surname : `${Array.from(parts[0])[0]}. ${surname}`
    const chars = Array.from(full)
    if (chars.length <= MAX_CHARS) return full
    const cut = chars.slice(0, MAX_CHARS - 1).join('')
    // Inside a hyphenated surname, drop the partial piece after the hyphen: "Gilgeous-A" → "Gilgeous".
    const surnameStart = full.length - surname.length
    const hyphen = cut.lastIndexOf('-')
    const kept = hyphen > surnameStart ? cut.slice(0, hyphen) : cut
    return `${kept.replace(/[\s.-]+$/, '')}…`
}
