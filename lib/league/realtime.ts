import { scopeWatchesToLeague, type TableChangeWatch } from '@/lib/realtime-config'

type LeagueScreenRefreshes = {
    members: () => void
    history: () => void
    settings: () => void
    draftBoard: () => void
    drafts: () => void
}

export function leagueScreenWatches(leagueId: string, refresh: LeagueScreenRefreshes): TableChangeWatch[] {
    return scopeWatchesToLeague(leagueId, [
        { table: 'league_members', onChange: refresh.members },
        { table: 'roster_transactions', onChange: refresh.history },
        { table: 'waiver_priorities', onChange: refresh.settings },
        { table: 'draft_picks', onChange: refresh.draftBoard },
        { table: 'drafts', onChange: refresh.drafts },
    ])
}
