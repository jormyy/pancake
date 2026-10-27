import { Text, type TextProps } from 'react-native'
import { componentTokens } from '@/constants/tokens'
import { formatPoints } from '@/lib/format'

type Props = TextProps & {
    value?: number | string | null
    highlight?: boolean
    integer?: boolean
    variant?: 'table' | 'summary'
}

export function StatCell({ value, highlight = false, integer = false, variant = 'table', style, ...props }: Props) {
    const display = typeof value === 'string' ? value : value != null && integer ? String(Math.round(Number(value))) : formatPoints(value)
    return <Text {...props} style={[variant === 'summary' ? componentTokens.statCell.summary : [{ width: componentTokens.statCell.width }, componentTokens.statCell.text], highlight && componentTokens.statCell.highlight, style]}>{display}</Text>
}
