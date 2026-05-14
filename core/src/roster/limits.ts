export function isRosterFull(activeCount: number, rosterSize: number): boolean {
    return activeCount >= rosterSize
}

export function hasTaxiSpace(taxiCount: number, taxiSlots: number): boolean {
    return taxiCount < taxiSlots
}
