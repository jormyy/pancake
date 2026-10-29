import { tradeCapacityLine } from './acceptance-summary'
import { Text, View } from 'react-native'
import type { TradeRosterPreview } from '@/lib/trades'
import { spacing, textStyles } from '@/constants/tokens'

export function TradeRosterPreviewList({ teams }: { teams: TradeRosterPreview[] }) {
    return <View style={{ gap: spacing.md }}>
        <Text style={textStyles.sectionLabel}>Resulting rosters</Text>
        {teams.map(team => <View key={team.memberId} style={{ gap: spacing.sm }}>
            <Text style={textStyles.body}>{tradeCapacityLine(team)}</Text>
            {(team.reasons ?? []).map((reason, index) => <View key={`${reason.rule}:${index}`} accessibilityRole="alert" style={{ gap: spacing.xs }}>
                <Text style={textStyles.body}>{reason.message}</Text>
                {reason.suggestedMoves.slice(0, 3).map((move, moveIndex) => <Text key={moveIndex} style={textStyles.meta}>{move.message}</Text>)}
            </View>)}
        </View>)}
    </View>
}
