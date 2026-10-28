import { useLocalSearchParams } from 'expo-router'
import { TeamTimelineScreen } from '@/components/timeline/TeamTimelineScreen'
import { useLeagueContext } from '@/contexts/league-context'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import type { TimelineFilter } from '@/lib/timeline'

export default function TimelineScreen() {
    const { memberId, entityId, filter } = useLocalSearchParams<{ memberId?: string; entityId?: string; filter?: string }>()
    const { current, currentLeague, membershipValidated, membershipError } = useLeagueContext()
    const activity = useBrowserReadActivity()
    const selectedFilter: TimelineFilter = filter === 'claims' || filter === 'trades' || filter === 'lineups' || filter === 'scores' ? filter : 'all'
    return <TeamTimelineScreen timezone={currentLeague?.timezone} leagueId={currentLeague?.id ?? null} memberId={memberId ?? current?.id ?? null}
        entityId={entityId} filter={selectedFilter} showTitle={false}
        teamName={!memberId || memberId === current?.id ? current?.team_name ?? undefined : undefined}
        enabled={membershipValidated && !membershipError && activity.active} />
}
