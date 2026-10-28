export function compactPlayerName(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean)
    if (parts.length > 1 && /^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(parts.at(-1)!)) parts.pop()
    const surname = parts.at(-1) ?? ''
    if (parts.length < 2) return surname
    const initialName = `${Array.from(parts[0])[0]}. ${surname}`
    return Array.from(initialName).length <= 12 ? initialName : surname
}
