import { Stack } from 'expo-router'
import { colors, fontWeight } from '@/constants/tokens'

/**
 * Web modals layout. On web these are NOT full-screen overlay takeovers — the
 * persistent WebAppShell (root) wraps them, so each renders as a page inside the
 * content area with the sidebar still visible. Headers are brand-styled; screens
 * that provide their own header opt out via headerShown:false.
 */
export default function ModalsLayoutWeb() {
    return (
        <Stack
            screenOptions={{
                presentation: 'card',
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
            <Stack.Screen name="team-roster" options={{ headerShown: false }} />
        </Stack>
    )
}
