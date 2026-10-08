import type { ReactNode } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors } from '@/constants/tokens'
import { PageHeader } from './Page'

/**
 * Frame for a screen opened on top of a tab (bracket, league settings, create
 * or join a league): a back button, the screen's title, and its main action on
 * the right.
 */
export function ModalScreen({
    title,
    onBack,
    backLabel = 'Back',
    actions,
    children,
}: {
    title: string
    onBack: () => void
    backLabel?: string
    actions?: ReactNode
    children: ReactNode
}) {
    const header = <PageHeader title={title} onBack={onBack} backLabel={backLabel} actions={actions} titleIsPageHeading />
    // The web shell already pads for the home indicator; only native needs the
    // bottom inset here.
    if (Platform.OS === 'web') {
        return <View style={styles.container}>{header}{children}</View>
    }
    return (
        <SafeAreaView style={styles.container} edges={['bottom']}>
            {header}
            {children}
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
})
