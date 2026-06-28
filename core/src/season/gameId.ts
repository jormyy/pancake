export function isRegularSeasonGameId(gameId: string | null | undefined): boolean {
    const id = gameId?.trim()
    if (!id) return false

    if (id.startsWith('002')) return true
    if (/^00\d/.test(id)) return false
    return true
}
