import {
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
} from 'react-native'
import { Stack } from 'expo-router'
import { useState } from 'react'
import { changePassword } from '@/lib/auth'
import { Input, Button, usePageMetrics } from '@/components/ui'
import { ModalScreen } from '@/components/ui/ModalScreen'
import { showSuccess } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'
import { layout, spacing } from '@/constants/tokens'
import { useGoBack } from '@/components/ui/useGoBack'

const MIN_PASSWORD_LENGTH = 8

export default function ChangePasswordScreen() {
    const back = useGoBack('/profile')
    const [currentPassword, setCurrentPassword] = useState('')
    const [newPassword, setNewPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    // Each message shows under the field it is about.
    const [error, setError] = useState<{ field: 'current' | 'new' | 'confirm'; message: string } | null>(null)
    const [saving, setSaving] = useState(false)
    const { padX } = usePageMetrics()

    async function handleSave() {
        const current = currentPassword
        const next = newPassword
        if (!current) {
            setError({ field: 'current', message: 'Enter your current password.' })
            return
        }
        if (next.length < MIN_PASSWORD_LENGTH) {
            setError({ field: 'new', message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` })
            return
        }
        if (next !== confirmPassword) {
            setError({ field: 'confirm', message: 'New passwords do not match.' })
            return
        }
        if (next === current) {
            setError({ field: 'new', message: 'New password must be different from your current password.' })
            return
        }
        setSaving(true)
        setError(null)
        try {
            await changePassword(current, next)
            showSuccess('Password Changed', 'Your password has been updated.')
            back()
        } catch (e) {
            setError({ field: 'current', message: getErrorMessage(e) ?? 'Could not change your password.' })
        } finally {
            setSaving(false)
        }
    }

    return (
        <>
        <Stack.Screen options={{ title: 'Change Password', headerShown: false }} />
        <ModalScreen
            title="Change Password"
            onBack={() => back()}
            actions={<Button title="Save" size="sm" onPress={handleSave} loading={saving} accessibilityLabel="Update password" />}
        >
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <ScrollView contentContainerStyle={[styles.content, { paddingHorizontal: padX }]} keyboardShouldPersistTaps="handled">

                <Input
                    label="Current password"
                    error={error?.field === 'current' ? error.message : undefined}
                    value={currentPassword}
                    onChangeText={setCurrentPassword}
                    secureTextEntry
                    autoComplete="current-password"
                    textContentType="password"
                    leftIcon="lock-outline"
                    returnKeyType="next"
                />
                <Input
                    label="New password"
                    error={error?.field === 'new' ? error.message : undefined}
                    value={newPassword}
                    onChangeText={setNewPassword}
                    secureTextEntry
                    autoComplete="new-password"
                    textContentType="newPassword"
                    leftIcon="lock"
                    returnKeyType="next"
                    hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
                />
                <Input
                    label="Confirm new password"
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    secureTextEntry
                    autoComplete="new-password"
                    textContentType="newPassword"
                    leftIcon="lock"
                    error={error?.field === 'confirm' ? error.message : undefined}
                    returnKeyType="done"
                    onSubmitEditing={handleSave}
                />
            </ScrollView>
        </KeyboardAvoidingView>
        </ModalScreen>
        </>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    content: {
        paddingTop: spacing.xl,
        paddingBottom: spacing['4xl'],
        gap: spacing.xl,
        width: '100%',
        maxWidth: layout.formMaxWidth + 2 * layout.pagePadX.regular,
        alignSelf: 'center',
    },
})
