export function matchupName(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean)
    if (parts.length > 1 && /^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(parts[parts.length - 1])) parts.pop()
    const surname = parts[parts.length - 1] ?? ''
    if (parts.length < 2 || Array.from(surname).length > 7) return Array.from(surname).slice(0, 10).join('').replace(/[-’']+$/, '')
    return `${Array.from(parts[0])[0]}. ${surname}`
}
