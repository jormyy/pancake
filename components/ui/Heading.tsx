import { Text, type TextProps } from 'react-native'
import { srOnly } from '@/constants/tokens'

type Props = TextProps & {
    level: 1 | 2 | 3
    /** Render for screen readers only (visually hidden). */
    hidden?: boolean
}

/**
 * Text that also exposes heading semantics on web (role="heading" + aria-level)
 * and native (accessibilityRole="header"). react-native-web does not map an
 * accessibilityRole of "header" to an aria-level, so both are set explicitly.
 * Replaces the inline `role="heading" aria-level={n}` triple repeated across
 * every screen.
 */
export function Heading({ level, hidden, style, children, ...rest }: Props) {
    return (
        <Text
            role="heading"
            aria-level={level}
            accessibilityRole="header"
            style={hidden ? [srOnly, style] : style}
            {...rest}
        >
            {children}
        </Text>
    )
}
