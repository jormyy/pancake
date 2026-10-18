import { createRoot } from 'react-dom/client'
import { Text, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { LivePulse, MotionPressable } from '../../components/Motion'
import { FeedbackProvider, feedbackBridge } from '../../components/ui/feedback'

createRoot(document.getElementById('root')!).render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 500, height: 500 }, insets: { top: 0, right: 0, bottom: 0, left: 0 } }}>
        <FeedbackProvider>
            <View style={{ padding: 40, gap: 40 }}>
                <MotionPressable nativeID="motion-press" onPress={() => feedbackBridge.api?.success('Saved for test')} style={{ padding: 20, backgroundColor: '#fde7a2' }}>
                    <Text>Show toast</Text>
                </MotionPressable>
                <View nativeID="pulse"><LivePulse color="#1b8839" size={10} /></View>
            </View>
        </FeedbackProvider>
    </SafeAreaProvider>,
)
