import { Modal, View, Text, Pressable, StyleSheet } from 'react-native'
import { colors } from '@/constants/tokens'

export function AutoSetModal({
    visible,
    onClose,
    onToday,
    onWholeWeek,
    onRestOfSeason,
}: {
    visible: boolean
    onClose: () => void
    onToday: () => void
    onWholeWeek: () => void
    onRestOfSeason: () => void
}) {
    return (
        <Modal
            visible={visible}
            animationType="fade"
            transparent
            onRequestClose={onClose}
        >
            <View style={styles.overlay}>
                <View style={styles.content}>
                    <Text style={styles.title}>Auto-Set Lineup</Text>
                    <Text style={styles.text}>Choose how to set your lineup</Text>
                    <View style={styles.buttons}>
                        <Pressable style={styles.button} onPress={onToday}>
                            <Text style={styles.buttonText}>Today</Text>
                        </Pressable>
                        <Pressable style={styles.button} onPress={onWholeWeek}>
                            <Text style={styles.buttonText}>Whole Week</Text>
                        </Pressable>
                    </View>
                    <Pressable style={styles.seasonButton} onPress={onRestOfSeason}>
                        <Text style={styles.buttonText}>Rest of Season</Text>
                    </Pressable>
                    <Pressable style={styles.cancel} onPress={onClose}>
                        <Text style={styles.cancelText}>Cancel</Text>
                    </Pressable>
                </View>
            </View>
        </Modal>
    )
}

const styles = StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: 20 },
    content: { backgroundColor: colors.bgScreen, borderRadius: 16, padding: 20, width: '100%', gap: 16 },
    title: { fontSize: 19, fontWeight: '800', color: colors.textPrimary, textAlign: 'center' },
    text: { fontSize: 14, color: colors.textMuted, textAlign: 'center' },
    buttons: { flexDirection: 'row', gap: 12 },
    button: { flex: 1, height: 48, backgroundColor: colors.primary, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
    seasonButton: { height: 48, backgroundColor: colors.primary, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
    buttonText: { fontSize: 15, fontWeight: '700', color: colors.textWhite },
    cancel: { paddingVertical: 8, alignItems: 'center' },
    cancelText: { fontSize: 15, fontWeight: '600', color: colors.textMuted },
})
