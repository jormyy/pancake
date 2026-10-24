import { withPwaMutation } from '@/lib/shared/pwa-mutation'
import { todayET } from '@/lib/shared/dates'
import { getWeekDays } from './read'
import { apiPost } from '@/lib/shared/api'

type AutoSetSeasonResult = {
    dates: number
    optimized: number
    skipped: number
    failed: number
    results: {
        date: string
        status: 'optimized' | 'skipped' | 'failed'
        reason?: string
    }[]
    metadataUpdated?: boolean
}

export async function autoSetLineup(
    memberId: string,
    leagueId: string,
    seasonId: string,
    weekNumber: number,
    seasonYear: number,
    gameDate: string | null,
    restOfSeason?: boolean,
    retryDates?: string[],
): Promise<AutoSetSeasonResult> {
    return withPwaMutation('autoSetLineup', async () => {
        let dates = retryDates
        if (!restOfSeason && !dates) {
            const today = todayET()
            const requested = gameDate ? [gameDate] : (await getWeekDays(weekNumber, seasonYear)).map(day => day.date)
            dates = requested.filter(date => date >= today)
        }
        if (dates?.length === 0) return { dates: 0, optimized: 0, skipped: 0, failed: 0, results: [] }
        return apiPost<AutoSetSeasonResult>('/league/lineup/auto-set-season', {
            memberId,
            leagueId,
            leagueSeasonId: seasonId,
            ...(dates ? { dates } : {}),
        })
    })
}
