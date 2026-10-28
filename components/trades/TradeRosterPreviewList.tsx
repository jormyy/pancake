import { tradeCapacityLine } from './acceptance-summary'
import { Text, View } from 'react-native'
import type { TradeRosterPreview } from '@/lib/trades'
import { spacing, textStyles } from '@/constants/tokens'

export function TradeRosterPreviewList({ teams }: { teams: TradeRosterPreview[] }) {
    return <View style={{ gap: spacing.md }}>
        <Text style={textStyles.sectionLabel}>Resulting rosters</Text>
        {teams.map(team => <Text key={team.memberId} style={textStyles.body}>{tradeCapacityLine(team)}</Text>)}
    </View>
}
