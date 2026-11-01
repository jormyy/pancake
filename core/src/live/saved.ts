import type { SavedLiveMatchup } from './overlay'

export function decodeSavedLiveView<T>(value: T): T {
    if (value && typeof value === 'object' && 'wireVersion' in value && value.wireVersion !== 1) throw new Error('Unsupported compact Home version')
    if (value && typeof value === 'object' && 'wireVersion' in value && value.wireVersion === 1) {
        const result = { ...value } as Record<string, unknown>
        const playerFields = ['rosterPlayerId', 'playerId', 'displayName', 'position', 'eligiblePositions', 'nbaTeam', 'yearsExp', 'careerGames', 'injuryStatus', 'nbaId', 'espnId', 'assetLocks']
        const statFields = ['points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers', 'threeMade', 'fgMade', 'fgAttempted', 'ftMade', 'ftAttempted', 'fouls', 'doubleDouble', 'tripleDouble', 'minutesPlayed', 'didNotPlay']
        const unpack = (row: unknown, fields: string[]) => {
            if (!Array.isArray(row) || row.length !== fields.length) throw new Error('Invalid compact Home row')
            return Object.fromEntries(fields.map((field, index) => [field, row[index]]))
        }
        for (const name of ['myLineup', 'oppLineup']) {
            const lineup = result[name] as Record<string, unknown> | null
            if (!lineup) continue
            result[name] = { ...lineup, ...Object.fromEntries(['starters', 'bench', 'ir', 'taxi'].map(group => {
                if (!Array.isArray(lineup[group])) throw new Error('Invalid compact Home lineup')
                return [group, lineup[group].map(row => {
                    if (group !== 'starters') return unpack(row, playerFields)
                    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string') throw new Error('Invalid compact Home starter')
                    return { slotType: row[0], player: row[1] === null ? null : unpack(row[1], playerFields) }
                })]
            })) }
        }
        if (!result.liveStats || typeof result.liveStats !== 'object' || Array.isArray(result.liveStats)) throw new Error('Invalid compact Home stats')
        result.liveStats = Object.fromEntries(Object.entries(result.liveStats).map(([id, row]) => [id, unpack(row, statFields)]))
        delete result.wireVersion
        value = result as T
    }
    if (!value || typeof value !== 'object' || !('liveBasis' in value) || !Array.isArray(value.liveBasis)
        || !value.liveBasis.length || !Array.isArray(value.liveBasis[0])) return value
    const number = (value: unknown) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid saved live score')
        return value
    }
    const text = (value: unknown) => {
        if (typeof value !== 'string') throw new Error('Invalid saved live identity')
        return value
    }
    const nullable = (value: unknown) => value === null ? null : text(value)
    const flag = (value: unknown, nullable = false) => {
        if (nullable && value === null) return false
        if (typeof value !== 'boolean') throw new Error('Invalid saved live flag')
        return value
    }
    const liveBasis: SavedLiveMatchup[] = value.liveBasis.map(row => {
        if (!Array.isArray(row) || row.length !== 8 || !Array.isArray(row[7])) throw new Error('Invalid saved live matchup')
        const homeMemberId = text(row[1]), awayMemberId = text(row[2])
        return { id: text(row[0]), homeMemberId, awayMemberId, homePoints: number(row[3]), awayPoints: number(row[4]),
            finalized: flag(row[5]), ready: flag(row[6]), players: row[7].map((player: unknown) => {
                if (!Array.isArray(player) || player.length !== 10 || ![0, 1].includes(player[1])) throw new Error('Invalid saved live player')
                return { playerId: text(player[0]), memberId: player[1] === 0 ? homeMemberId : awayMemberId,
                    nbaId: nullable(player[2]), espnId: nullable(player[3]), team: nullable(player[4]), gameId: nullable(player[5]),
                    savedPoints: number(player[6]), savedAt: number(player[7]), starter: flag(player[8]), final: flag(player[9], true) }
            }) }
    })
    return { ...value, liveBasis }
}
