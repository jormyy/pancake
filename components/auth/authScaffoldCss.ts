import { breakpoints, fontSize, spacing } from '@/constants/tokens'
import { Platform } from 'react-native'

export function authWebAttributes(part: 'authHero' | 'authShell' | 'authScroll' | 'authCard' | 'authTitle' | 'authMobileBrand') {
    return Platform.OS === 'web' ? { dataSet: { [part]: '' } } : {}
}

export const AUTH_SCAFFOLD_CSS = `
html [data-auth-hero] { display: none; }
html [data-auth-scroll] > div {
    justify-content: flex-start;
    padding: ${spacing.xl}px ${spacing.lg}px;
}
html [data-auth-card] { padding: ${spacing['2xl']}px; }
html [data-auth-title] { font-size: ${fontSize['3xl']}px; line-height: 32px; }
@media (min-width: ${breakpoints.phone}px) {
    html [data-auth-scroll] > div {
        justify-content: center;
        padding: ${spacing['4xl']}px ${spacing['3xl']}px;
    }
    html [data-auth-card] { padding: ${spacing['4xl']}px; }
    html [data-auth-title] { font-size: ${fontSize['4xl']}px; line-height: 38px; }
}
@media (min-width: ${breakpoints.auth}px) {
    html [data-auth-shell] { flex-direction: row; }
    html [data-auth-hero] { display: flex; }
    html [data-auth-mobile-brand] { display: none; }
    html [data-auth-scroll] > div { padding: ${spacing['5xl']}px; }
}
`
