import { Text } from 'react-native'
import { sessionOwner } from '@/lib/session-cache-registry'
import { usePendingMutations } from '@/hooks/use-pending-mutations'
import { textStyles } from '@/constants/tokens'

export function PendingMutationBadge({ rowId }: { rowId: string }) {
    const { pending } = usePendingMutations(sessionOwner())
    const selected = pending.filter(job => job.rowIds.includes(rowId))
    if (!selected.length) return null
    return <Text style={textStyles.meta} accessibilityRole="text">{selected.some(job => job.status === 'failed') ? 'Pending · Retry needed' : 'Pending'}</Text>
}
