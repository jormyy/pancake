export function activeRosterOverflow(activeCount: number, rosterSize: number): number {
    return Math.max(0, activeCount - Math.max(0, rosterSize))
}
