import { Component, Suspense, lazy, type ReactNode } from 'react'
import { Text, View } from 'react-native'
import { Button } from '@/components/ui/Button'
import { ModalScreen } from '@/components/ui/ModalScreen'
import { useGoBack } from '@/components/ui/useGoBack'
import { spacing, textStyles } from '@/constants/tokens'

function loadTimeline() {
    return lazy(() => import('@/components/timeline/TimelineScreen'))
}

function TimelineFrame({ children }: { children: ReactNode }) {
    const goBack = useGoBack('/roster')
    return <ModalScreen title="Timeline" onBack={goBack}>{children}</ModalScreen>
}

export default class TimelineRoute extends Component<object, { failed: boolean; Screen: ReturnType<typeof loadTimeline> }> {
    state = { failed: false, Screen: loadTimeline() }
    static getDerivedStateFromError() { return { failed: true } }
    render() {
        if (this.state.failed) return <TimelineFrame><View style={{ padding: spacing.lg, gap: spacing.md }}>
            <Text style={textStyles.body} accessibilityRole="alert">The season timeline could not load.</Text>
            <Button title="Retry timeline" onPress={() => this.setState({ failed: false, Screen: loadTimeline() })} />
        </View></TimelineFrame>
        const Screen = this.state.Screen
        return <TimelineFrame><Suspense fallback={<Text style={textStyles.body}>Loading season timeline…</Text>}><Screen /></Suspense></TimelineFrame>
    }
}
