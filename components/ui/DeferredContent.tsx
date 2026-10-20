import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native'
import { sessionGeneration } from '@/lib/session-cache-registry'

export function DeferredContent({ ready, children, style, fallback, busy = !ready }: { ready: boolean; busy?: boolean; children?: ReactNode; fallback?: ReactNode; style?: StyleProp<ViewStyle> }) {
    const identity = String(sessionGeneration())
    const previous = useRef<{ identity: string; children: ReactNode }>({ identity, children: null })
    if (previous.current.identity !== identity) previous.current = { identity, children: null }
    useLayoutEffect(() => {
        if (ready) previous.current = { identity, children }
    }, [ready, identity, children])
    const webProps = Platform.OS === 'web' ? { inert: !ready } : {}
    return (
        <View {...webProps} style={[{ flex: 1, minHeight: 320 }, style]} aria-busy={busy || !ready} accessibilityState={{ busy: busy || !ready }} pointerEvents={ready ? 'auto' : 'none'} accessibilityElementsHidden={!ready} importantForAccessibility={ready ? 'auto' : 'no-hide-descendants'}>
            {ready ? children : previous.current.children ?? fallback}
        </View>
    )
}
