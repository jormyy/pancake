const bgCache = new Map<string, { backgroundColor: string }>()

export function bgStyle(color: string): { backgroundColor: string } {
    let s = bgCache.get(color)
    if (!s) {
        s = { backgroundColor: color }
        bgCache.set(color, s)
    }
    return s
}
