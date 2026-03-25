import { Stack } from 'expo-router'

export default function ModalsLayout() {
    return (
        <Stack>
            <Stack.Screen
                name="create-league"
                options={{ title: 'Create League', presentation: 'modal' }}
            />
            <Stack.Screen
                name="join-league"
                options={{ title: 'Join League', presentation: 'modal' }}
            />
            <Stack.Screen
                name="commissioner-settings"
                options={{ title: 'League Settings', presentation: 'modal' }}
            />
            <Stack.Screen
                name="draft-room"
                options={{ title: 'Draft Room', headerBackVisible: false }}
            />
            <Stack.Screen
                name="lineup"
                options={{ headerShown: false, presentation: 'modal' }}
            />
            <Stack.Screen
                name="propose-trade"
                options={{ headerShown: false, presentation: 'modal' }}
            />
            <Stack.Screen
                name="trades"
                options={{ headerShown: false, presentation: 'modal' }}
            />
        </Stack>
    )
}
