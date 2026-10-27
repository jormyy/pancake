import { Pressable, Text, View } from 'react-native'
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
    return <View style={{ padding: spacing.sm }} accessibilityRole="summary" accessibilityLiveRegion="polite">
        <Text style={textStyles.meta}>{failed ? 'Your action is saved. It needs another try.' : `${pending.length} action${pending.length === 1 ? '' : 's'} pending`}</Text>
        {failed ? <Pressable accessibilityRole="button" accessibilityLabel="Retry saved action" onPress={() => retry(failed.id)}><Text style={textStyles.body}>Retry</Text></Pressable> : null}
    </View>
}
