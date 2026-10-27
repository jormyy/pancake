import { Component, Suspense } from 'react'
import { Text, View } from 'react-native'
import { Button } from '@/components/ui/Button'
import { spacing, textStyles } from '@/constants/tokens'

import { loadTimeline } from '@/components/navigation/TimelineScreenLoader'

export default class TimelineRoute extends Component<object, { failed: boolean; Screen: ReturnType<typeof loadTimeline> }> {
    state = { failed: false, Screen: loadTimeline() }
    static getDerivedStateFromError() { return { failed: true } }
    render() {
        if (this.state.failed) return <View style={{ padding: spacing.lg, gap: spacing.md }}>
            <Text style={textStyles.body} accessibilityRole="alert">The season timeline could not load.</Text>
            <Button title="Retry timeline" onPress={() => this.setState({ failed: false, Screen: loadTimeline() })} />
        </View>
        const Screen = this.state.Screen
        return <Suspense fallback={<Text style={textStyles.body}>Loading season timeline…</Text>}><Screen /></Suspense>
    }
}
