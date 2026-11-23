import { useEffect, useState } from 'react'
import { endOfLeagueDayUTC, resolveLeagueTimezone, todayLeague } from '@/lib/timezone'
import { onLifecycle } from '@/lib/lifecycle'

export function useLeagueDay(timezone?: string | null): string {
    const zone = resolveLeagueTimezone(timezone)
    const [, render] = useState(0)
    const day = todayLeague(zone)
    useEffect(() => {
        const update = () => render(value => value + 1)
        const timer = setTimeout(update, Math.max(1, Date.parse(endOfLeagueDayUTC(day, zone)) - Date.now() + 1))
        const stop = onLifecycle(['focus', 'online', 'visible', 'hidden'], update)
        return () => {
            clearTimeout(timer)
            stop()
        }
    }, [day, zone])
    return day
}
