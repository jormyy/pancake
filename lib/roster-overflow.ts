export function activeRosterOverflow(activeCount: number, rosterSize: number | null): number {
    if (rosterSize == null) return 0
    return Math.max(0, activeCount - Math.max(0, rosterSize))
}

export function createRosterRecoveryRunner() {
    let active = false

    return async (recovery: () => Promise<void>): Promise<boolean> => {
        if (active) return false
        active = true
        try {
            await recovery()
            return true
        } finally {
            active = false
        }
    }
}
