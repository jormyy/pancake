import type { PropsWithChildren } from 'react'
import { PanelActivityContext, usePanelActivity } from '@/contexts/panel-activity'
import { Platform, StyleSheet, View } from 'react-native'

// Keep list dimensions while hidden so browsers retain their scroll position.
export function RetainedPanel({ active, children }: PropsWithChildren<{ active: boolean }>) {
    const parentActive = usePanelActivity()
    const content = <PanelActivityContext.Provider value={parentActive && active}>{children}</PanelActivityContext.Provider>
    if (Platform.OS === 'web') {
        return (
            <div
                inert={!active}
                aria-hidden={!active}
                style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', visibility: active ? 'inherit' : 'hidden' }}
            >
                {content}
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
            {content}
        </View>
    )
}
