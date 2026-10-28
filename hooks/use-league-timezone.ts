import { useLeagueContext } from '@/contexts/league-context'
import { resolveLeagueTimezone } from '@/lib/timezone'

export function useLeagueTimezone(): string {
    const { currentLeague } = useLeagueContext()
    return resolveLeagueTimezone(currentLeague?.timezone)
}
