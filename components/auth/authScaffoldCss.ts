import { breakpoints, spacing } from '@/constants/tokens'
import { Platform } from 'react-native'

export function authWebAttributes(part: 'authHero' | 'authShell' | 'authScroll' | 'authCard' | 'authMobileBrand') {
    return Platform.OS === 'web' ? { dataSet: { [part]: '' } } : {}
}

export const AUTH_SCAFFOLD_CSS = `
html [data-auth-hero] { display: none; }
html [data-auth-scroll] > div {
    justify-content: flex-start;
    padding: calc(env(safe-area-inset-top, ${spacing.none}px) + ${spacing.lg}px) ${spacing.lg}px calc(env(safe-area-inset-bottom, ${spacing.none}px) + ${spacing.lg}px);
}
html [data-auth-card] { padding: ${spacing.xl}px; }
@media (min-width: ${breakpoints.phone}px) {
    html [data-auth-scroll] > div {
        justify-content: center;
        padding: ${spacing['4xl']}px ${spacing['3xl']}px;
    }
    html [data-auth-card] { padding: ${spacing['4xl']}px; }
}
@media (min-width: ${breakpoints.auth}px) {
    html [data-auth-shell] { flex-direction: row; }
    html [data-auth-hero] { display: flex; }
    html [data-auth-mobile-brand] { display: none; }
    html [data-auth-scroll] > div { padding: ${spacing['5xl']}px; }
}
`
