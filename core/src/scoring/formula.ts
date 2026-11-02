import { StatLine, ScoringSettings } from './types'

export function calculateFantasyPoints(
    stats: StatLine,
    settings: ScoringSettings,
): number {
    if (stats.didNotPlay) return 0
    const terms: [number, number | undefined][] = [
        [stats.points, settings.points], [stats.rebounds, settings.rebounds],
        [stats.assists, settings.assists], [stats.steals, settings.steals],
        [stats.blocks, settings.blocks], [stats.turnovers, settings.turnovers],
        [stats.threePointersMade, settings.three_pointers_made],
        [stats.fieldGoalsMade, settings.field_goals_made], [stats.fieldGoalsAttempted, settings.field_goals_attempted],
        [stats.freeThrowsMade, settings.free_throws_made], [stats.freeThrowsAttempted, settings.free_throws_attempted],
        [stats.doubleDouble ? 1 : 0, settings.double_double], [stats.tripleDouble ? 1 : 0, settings.triple_double],
    ]
    const products: [bigint, number][] = []
    for (const [amount, weight = 0] of terms) {
        if (!Number.isFinite(amount) || !Number.isFinite(weight)) return NaN
        if (!amount || !weight) continue
        const [left, leftScale] = decimalValue(amount)
        const [right, rightScale] = decimalValue(weight)
        products.push([left * right, leftScale + rightScale])
    }
    const scale = Math.max(2, ...products.map(([, digits]) => digits))
    const total = products.reduce((sum, [value, digits]) => sum + value * 10n ** BigInt(scale - digits), 0n)
    const divisor = 10n ** BigInt(scale - 2)
    const sign = total < 0n ? -1n : 1n
    return Number(sign * ((total * sign + divisor / 2n) / divisor)) / 100

}

function decimalValue(value: number): [bigint, number] {
    const [coefficient, exponent = '0'] = value.toString().split('e')
    return [BigInt(coefficient.replace('.', '')), (coefficient.split('.')[1]?.length ?? 0) - Number(exponent)]
}

export function roundFantasyPoints(value: number): number {
    const sign = Math.sign(value) || 1
    const [coefficient, exponent = '0'] = Math.abs(value).toString().split('e')
    const shifted = Number(`${coefficient}e${Number(exponent) + 2}`)
    return sign * Number(`${Math.round(shifted)}e-2`)
}

/**
 * Convert a snake_case stat row (as stored in the DB) into a camelCase StatLine.
 * Missing or null fields default to 0 / false so callers don't need to guard.
 */
export function snakeToStatLine(row: Record<string, unknown>): StatLine {
    return {
        points: (row.points as number) ?? 0,
        rebounds: (row.rebounds as number) ?? 0,
        assists: (row.assists as number) ?? 0,
        steals: (row.steals as number) ?? 0,
        blocks: (row.blocks as number) ?? 0,
        turnovers: (row.turnovers as number) ?? 0,
        threePointersMade: (row.three_pointers_made as number) ?? 0,
        fieldGoalsMade: (row.field_goals_made as number) ?? 0,
        fieldGoalsAttempted: (row.field_goals_attempted as number) ?? 0,
        freeThrowsMade: (row.free_throws_made as number) ?? 0,
        freeThrowsAttempted: (row.free_throws_attempted as number) ?? 0,
        doubleDouble: (row.double_double as boolean) ?? false,
        tripleDouble: (row.triple_double as boolean) ?? false,
        didNotPlay: (row.did_not_play as boolean) ?? false,
    }
}
