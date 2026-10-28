import { useEffect, useState } from 'react'
import { endOfLeagueDayUTC, resolveLeagueTimezone, todayLeague } from '@/lib/timezone'

export function useLeagueDay(timezone?: string | null): string {
    const zone = resolveLeagueTimezone(timezone)
    const [, render] = useState(0)
    const day = todayLeague(zone)
    useEffect(() => {
        const update = () => render(value => value + 1)
        const timer = setTimeout(update, Math.max(1, Date.parse(endOfLeagueDayUTC(day, zone)) - Date.now() + 1))
        if (typeof window !== 'undefined') {
            window.addEventListener('focus', update)
            window.addEventListener('pageshow', update)
            window.addEventListener('online', update)
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', update)
        return () => {
            clearTimeout(timer)
            if (typeof window !== 'undefined') {
                window.removeEventListener('focus', update)
                window.removeEventListener('pageshow', update)
                window.removeEventListener('online', update)
            }
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', update)
        }
    }, [day, zone])
    return day
}
