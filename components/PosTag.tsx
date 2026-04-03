import { Text } from 'react-native'
import { POSITION_COLORS } from '@/constants/positions'
import { palette } from '@/constants/tokens'

export function PosTag({ position }: { position: string }) {
    const color = POSITION_COLORS[position] ?? palette.gray500
    return (
        <Text style={{ fontSize: 9, fontWeight: '800', color }}>{position}</Text>
    )
}
