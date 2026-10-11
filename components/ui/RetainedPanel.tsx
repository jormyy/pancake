import type { ReactNode } from 'react'
import { Platform, StyleSheet, View } from 'react-native'

// Keep list dimensions while hidden so browsers retain their scroll position.
export function RetainedPanel({ active, children }: { active: boolean; children: ReactNode }) {
    if (Platform.OS === 'web') {
        return (
            <div
                inert={!active}
                aria-hidden={!active}
                style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', visibility: active ? 'inherit' : 'hidden' }}
            >
                {children}
            </div>
        )
    }
    return (
        <View
            style={[StyleSheet.absoluteFill, !active && { opacity: 0 }]}
            pointerEvents={active ? 'auto' : 'none'}
            accessibilityElementsHidden={!active}
            importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
        >
            {children}
        </View>
    )
}
