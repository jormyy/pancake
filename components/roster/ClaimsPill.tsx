import { useRouter } from 'expo-router'
import { StyleSheet } from 'react-native'
import { Button } from '@/components/ui/Button'
import { controlSize, radii } from '@/constants/tokens'

export function ClaimsPill({ count }: { count: number }) {
    const { push } = useRouter()
    return <Button title={`${count} ${count === 1 ? 'Waiver' : 'Waivers'}`} size="inline" variant="outline" style={styles.pill}
        accessibilityLabel={`${count} pending claims, open ${count > 0 ? 'Waivers' : 'Players'}`}
        onPress={() => push(count > 0 ? '/players?section=waivers' : '/players?section=players')} />
}

const styles = StyleSheet.create({
    pill: { minWidth: controlSize.minTouch, minHeight: controlSize.minTouch, borderRadius: radii.full },
})
