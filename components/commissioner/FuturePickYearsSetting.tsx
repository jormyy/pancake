import { useEffect, useRef, useState } from 'react'
import { Text, TextInput, View } from 'react-native'
import { useLeagueContext } from '@/contexts/league-context'
import { Button, ErrorBanner } from '@/components/ui'
import { styles } from '@/components/commissioner/settings-styles'
import { getLeagueFuturePickYears, updateLeagueConfiguration } from '@/lib/league'
import { getErrorMessage } from '@/lib/shared/errors'

function FuturePickYearsEditor({ leagueId, disabled }: { leagueId: string; disabled: boolean }) {
    const [value, setValue] = useState('')
    const [baseline, setBaseline] = useState<number | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [saved, setSaved] = useState(false)
    const [saving, setSaving] = useState(false)
    const [attempt, setAttempt] = useState(0)
    const active = useRef(true)
    useEffect(() => {
        let current = true
        active.current = true
        getLeagueFuturePickYears(leagueId).then(years => {
            if (!current) return
            setBaseline(years)
            setValue(String(years))
            setError(null)
        }).catch(reason => { if (current) setError(getErrorMessage(reason) ?? 'Could not load future draft years.') })
        return () => { current = false; active.current = false }
    }, [leagueId, attempt])

    async function save() {
        const years = Number(value)
        if (!/^\d+$/.test(value) || !Number.isInteger(years) || years < 1 || years > 10) {
            setError('Future draft years must be a whole number between 1 and 10.')
            return
        }
        setSaving(true)
        setError(null)
        try {
            await updateLeagueConfiguration(leagueId, { future_pick_years: years }, null)
            if (active.current) { setBaseline(years); setValue(String(years)); setSaved(true) }
        } catch (reason) {
            if (active.current) setError(getErrorMessage(reason) ?? 'Could not save future draft years.')
        } finally {
            if (active.current) setSaving(false)
        }
    }

    return <>
        <Text style={styles.sectionTitle} role="heading" aria-level={2} accessibilityRole="header">Future draft picks</Text>
        <View style={styles.card}>
            <View style={styles.row}>
                <Text style={styles.rowLabel}>Future Draft Years (1–10)</Text>
                <TextInput style={styles.scoreInput} accessibilityLabel="Future Draft Years (1–10)" keyboardType="numeric"
                    value={value} editable={!disabled && baseline !== null && !saving}
                    onChangeText={text => { setValue(text); setSaved(false); setError(null) }} />
            </View>
            <Text style={styles.settingHint}>Increasing the window creates picks for every team. Lowering is blocked if a later pick has been traded or included in a trade.</Text>
            {error ? <ErrorBanner message={error} onRetry={baseline === null ? () => setAttempt(attempt + 1) : save} /> : null}
            {baseline === null && !error ? <Text style={styles.settingHint}>Loading future draft years…</Text> : null}
            {saved ? <Text style={styles.settingHint} accessibilityLiveRegion="polite">Future draft years saved.</Text> : null}
            <Button title={saving ? 'Saving…' : 'Save future draft years'} onPress={save}
                disabled={disabled || saving || baseline === null || value === String(baseline)} accessibilityLabel="Save future draft years" />
        </View>
    </>
}

export function FuturePickYearsSetting({ disabled }: { disabled: boolean }) {
    const { currentLeague } = useLeagueContext()
    return currentLeague ? <FuturePickYearsEditor key={currentLeague.id} leagueId={currentLeague.id} disabled={disabled} /> : null
}
