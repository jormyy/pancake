import { Stack } from 'expo-router'
import { colors, fontWeight } from '@/constants/tokens'

export { RouteErrorBoundary as ErrorBoundary } from '@/components/navigation/RouteErrorBoundary'

export default function ModalsLayout() {
    return (
        <Stack
            screenOptions={{
                presentation: 'card',
                headerShown: false,
                animation: 'fade',
                headerStyle: { backgroundColor: colors.bgCard },
                headerTintColor: colors.textPrimary,
                headerTitleStyle: { fontWeight: fontWeight.extrabold },
                headerShadowVisible: false,
            }}
        >
            <Stack.Screen name="create-league" options={{ title: 'Create League', headerShown: false }} />
            <Stack.Screen name="join-league" options={{ title: 'Join League', headerShown: false }} />
            <Stack.Screen name="commissioner-settings" options={{ title: 'League Settings' }} />
            <Stack.Screen name="change-password" options={{ title: 'Change Password' }} />
            <Stack.Screen name="draft-room" options={{ title: 'Draft Room', headerShown: false }} />
            <Stack.Screen name="rookie-draft-room" options={{ title: 'Rookie Draft', headerShown: false }} />
            <Stack.Screen name="lineup" options={{ headerShown: false }} />
            <Stack.Screen name="propose-trade" options={{ headerShown: false }} />
            <Stack.Screen name="claim-player" options={{ title: 'Waiver Claim', headerShown: false }} />
            <Stack.Screen name="bracket" options={{ title: 'Playoff Bracket' }} />
            <Stack.Screen name="notification-settings" options={{ title: 'Notifications', headerShown: false }} />
            <Stack.Screen name="timeline" options={{ title: 'Timeline' }} />
            <Stack.Screen name="matchup" options={{ headerShown: false }} />
            <Stack.Screen name="team-roster" options={{ headerShown: false }} />
        </Stack>
    )
}
