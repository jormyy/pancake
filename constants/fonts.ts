import { Outfit_500Medium, Outfit_600SemiBold, Outfit_700Bold } from '@expo-google-fonts/outfit'
import { FontDisplay } from 'expo-font'
import { Platform } from 'react-native'

const display = Platform.OS === 'web' ? FontDisplay.OPTIONAL : FontDisplay.SWAP

export const criticalFonts = {
    Outfit_500Medium: { uri: Outfit_500Medium, display },
    Outfit_600SemiBold: { uri: Outfit_600SemiBold, display },
    Outfit_700Bold: { uri: Outfit_700Bold, display },
}
