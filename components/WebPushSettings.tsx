import { useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { Button } from '@/components/ui'
import { colors, fontSize, fontWeight, spacing } from '@/constants/tokens'
import { showAlert } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'
import {
    disableWebPush,
    enableWebPush,
    getWebPushStatus,
    getWebPushPublicKey,
    sendTestWebPush,
    type WebPushStatus,
} from '@/lib/web-push'

const STATUS_COPY: Partial<Record<WebPushStatus, string>> = {
    'needs-install': 'To get notifications on iPhone, tap Share → Add to Home Screen, then open Pancake from your Home Screen.',
    unsupported: 'This browser does not support push notifications.',
    unavailable: 'Push notifications are not available yet.',
    denied: 'Notifications are blocked. Allow them for Pancake in your device or browser settings, then reopen the app.',
}

/** Web-only "this device" push control for the Profile notifications card. */
export function WebPushSettings({ onStatusChange }: { onStatusChange?: (status: WebPushStatus) => void }) {
    const [status, setStatus] = useState<WebPushStatus | null>(null)
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        let active = true
        // Warm the VAPID key so the tap handler can prompt before any network wait.
        getWebPushPublicKey().catch(() => null)
        getWebPushStatus()
            .then((next) => { if (active) setStatus(next) })
            .catch(() => { if (active) setStatus('unavailable') })
        return () => { active = false }
    }, [])

    useEffect(() => {
        if (status) onStatusChange?.(status)
    }, [status, onStatusChange])

    function handleEnable() {
        // No await before enableWebPush(): Safari only prompts inside the tap.
        setBusy(true)
        enableWebPush()
            .then(setStatus)
            .catch((error) => showAlert('Error', getErrorMessage(error)))
            .finally(() => setBusy(false))
    }

    async function handleDisable() {
        setBusy(true)
        try {
            await disableWebPush()
            setStatus('off')
        } catch (error) {
            showAlert('Error', getErrorMessage(error))
        } finally {
            setBusy(false)
        }
    }

    async function handleTest() {
        setBusy(true)
        try {
            const result = await sendTestWebPush()
            if (result.sent === 0) {
                showAlert('No notification sent', 'This device is not registered anymore. Turn notifications off and on again.')
                setStatus(await getWebPushStatus())
            }
        } catch (error) {
            showAlert('Error', getErrorMessage(error))
        } finally {
            setBusy(false)
        }
    }

    if (!status) {
        return (
            <View style={styles.row}>
                <Text style={styles.label}>This device</Text>
                <ActivityIndicator color={colors.primary} />
            </View>
        )
    }

    const copy = STATUS_COPY[status]
    return (
        <View style={styles.row}>
            <View style={styles.text}>
                <Text style={styles.label}>This device</Text>
                <Text style={styles.detail}>
                    {copy ?? (status === 'on' ? 'Push notifications are on.' : 'Get alerts for trades, waivers, and drafts.')}
                </Text>
            </View>
            {status === 'off' ? (
                <Button title="Turn on" size="sm" icon="notifications-active" loading={busy} onPress={handleEnable} />
            ) : null}
            {status === 'on' ? (
                <View style={styles.actions}>
                    <Button title="Test" size="sm" variant="outline" disabled={busy} onPress={handleTest} />
                    <Button title="Turn off" size="sm" variant="ghost" disabled={busy} onPress={handleDisable} />
                </View>
            ) : null}
        </View>
    )
}

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        paddingHorizontal: spacing.xl,
        paddingVertical: 14,
        gap: spacing.lg,
    },
    text: { flex: 1, minWidth: 180, gap: 2 },
    label: { fontSize: fontSize.md, color: colors.textPrimary, fontWeight: fontWeight.semibold },
    detail: { fontSize: fontSize.sm, color: colors.textMuted },
    actions: { flexDirection: 'row', gap: spacing.sm },
})
