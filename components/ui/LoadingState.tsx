import { useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { colors, spacing } from '@/constants/tokens'

const SHOW_AFTER_MS = 500

/**
 * What a page shows while its data loads. Fast loads stay blank, so content
 * appears fully formed; a slow one gets a spinner instead of an empty page.
 * Never show placeholder facts in its place.
 */
export function LoadingState() {
    const [visible, setVisible] = useState(false)
    useEffect(() => {
        const timer = setTimeout(() => setVisible(true), SHOW_AFTER_MS)
        return () => clearTimeout(timer)
    }, [])
    return (
        <View style={styles.wrap} accessibilityLiveRegion="polite">
            {visible ? <ActivityIndicator color={colors.textMuted} accessibilityLabel="Loading" /> : null}
        </View>
    )
}

const styles = StyleSheet.create({
    wrap: { paddingVertical: spacing['4xl'], alignItems: 'center', justifyContent: 'center' },
})
