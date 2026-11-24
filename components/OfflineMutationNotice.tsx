import { Text, View } from 'react-native'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import { usePendingMutations } from '@/hooks/use-pending-mutations'
import { textStyles, spacing } from '@/constants/tokens'

export function OfflineMutationNotice() {
    const { user } = useAuth()
    const { currentLeague } = useLeagueContext()
    const { pending, retry } = usePendingMutations(user?.id, currentLeague?.id)
    if (!pending.length) return null
    const failed = pending.find(job => job.status === 'failed')
    return <View style={{ padding: spacing.sm, gap: spacing.xs }} accessibilityRole="summary" accessibilityLiveRegion="polite">
        <Text style={textStyles.meta}>{failed ? 'Your action is saved. It needs another try.' : `${pending.length} action${pending.length === 1 ? '' : 's'} pending`}</Text>
        {failed ? <Button size="sm" variant="outline" title="Retry" accessibilityLabel="Retry saved action" style={{ alignSelf: 'flex-start' }} onPress={() => retry(failed.id)} /> : null}
    </View>
}
