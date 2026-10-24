import { useState, type ComponentProps } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { spacing, textStyles } from '@/constants/tokens'
import { TransactionHistory } from './TransactionHistory'

export function PlayerHistory(props: ComponentProps<typeof TransactionHistory>) {
    const [expanded, setExpanded] = useState(false)
    if (props.transactions.length === 0) return null

    return (
        <View>
            <Pressable
                onPress={() => setExpanded(value => !value)}
                style={styles.toggle}
                accessibilityRole="button"
                accessibilityLabel="League history"
                accessibilityState={{ expanded }}
                aria-expanded={expanded}
            >
                <Text style={textStyles.sectionLabel} role="heading" aria-level={2}>League history</Text>
                <Text style={textStyles.meta}>{expanded ? '▴' : '▾'}</Text>
            </Pressable>
            {expanded ? <TransactionHistory {...props} showHeading={false} /> : null}
        </View>
    )
}

const styles = StyleSheet.create({
    toggle: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
})
