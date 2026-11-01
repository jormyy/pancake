import type { LiveLine, PublicLiveStats } from './overlay'

export function liveLineStats(row: LiveLine): PublicLiveStats | null {
    if (row.length !== 19 || !/^\d+$/.test(row[0]) || row.slice(1).some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 2147483647)) return null
    if (row.slice(1).some((value, index) => index !== 15 && Number(value) < 0) || ![0,1].includes(row[18])) return null
    const doubles = [row[1],row[2],row[3],row[4],row[5]].filter(value => value >= 10).length
    return { points: row[1], rebounds: row[2], assists: row[3], steals: row[4], blocks: row[5], turnovers: row[6],
        threePointersMade: row[7], threePointersAttempted: row[8], fieldGoalsMade: row[9], fieldGoalsAttempted: row[10],
        freeThrowsMade: row[11], freeThrowsAttempted: row[12], offensiveRebounds: row[13], defensiveRebounds: row[14],
        fouls: row[15], plusMinus: row[16], minutesPlayed: row[17], didNotPlay: row[18] === 1,
        doubleDouble: doubles >= 2, tripleDouble: doubles >= 3 }
}

