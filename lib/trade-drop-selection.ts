export function selectTradeDrop(current: ReadonlySet<string>, rosterPlayerId: string): Set<string> {
    return new Set([...current, rosterPlayerId])
}

export function rollbackTradeDrop(current: ReadonlySet<string>, rosterPlayerId: string): Set<string> {
    const retryable = new Set(current)
    retryable.delete(rosterPlayerId)
    return retryable
}
