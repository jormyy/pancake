import { useState, type ReactNode } from 'react'
import { Pressable, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { PlayerRowContent, type PlayerRowContentProps } from '@/components/player/PlayerRowContent'
import { tradePlayerDetailRoute, type TradePlayerIdentity } from '@/components/player/navigation'
import { colors, controlSize, radii } from '@/constants/tokens'

export function useTradePlayerNavigation() {
    const router = useRouter()
    return (player: TradePlayerIdentity) => router.push(tradePlayerDetailRoute(player))
}

export type TradePlayerLinkProps = Omit<PlayerRowContentProps, 'playerId' | 'locks'> & TradePlayerIdentity & { children?: ReactNode }

export function TradePlayerLink(props: TradePlayerLinkProps) {
    const openPlayer = useTradePlayerNavigation()
    const [focused, setFocused] = useState(false)
    return <Pressable style={[styles.link, focused && styles.focused]}
        onPress={() => openPlayer(props)}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        accessibilityRole="button" accessibilityLabel={`View ${props.name} stats`}>
        {props.children ?? <PlayerRowContent {...props} />}
    </Pressable>
}

const styles = StyleSheet.create({
    link: { flex: 1, minWidth: 0, minHeight: controlSize.minTouch, justifyContent: 'center', borderRadius: radii.sm },
    focused: { outlineWidth: 2, outlineStyle: 'solid', outlineColor: colors.primaryDark },
})
