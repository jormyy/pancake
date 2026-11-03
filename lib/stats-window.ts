export type StatsWindowDays = 7 | 15 | null
export type StatsWindow = { days: 7 | 15; startDate: string; endDate: string; timeZone: string }

export const STATS_WINDOW_OPTIONS = [
    { key: 'season', label: 'Season' },
    { key: '7', label: 'Past 7 days' },
    { key: '15', label: 'Past 15 days' },
] as const

export function statsWindowDays(value: string): StatsWindowDays {
    return value === '7' ? 7 : value === '15' ? 15 : null
}

export function statsWindowLabel(window: StatsWindow | null | undefined): string {
    if (!window) return ''
    return `${window.startDate} – ${window.endDate} ET · Per game · Includes today`
}
