import { Text } from 'react-native'
import { getPositionColor } from '@/constants/positions'

export function PosTag({ position }: { position: string }) {
    const color = getPositionColor(position)
    return (
        <Text style={{ fontSize: 9, fontWeight: '800', color }}>{position}</Text>
    )
}
