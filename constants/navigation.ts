export const SHELL_SECTION_CHILDREN: Partial<Record<string, string[]>> = {
    '/roster': ['/lineup'],
    '/players': ['/player/', '/claim-player'],
    '/trades': ['/propose-trade'],
    '/league': ['/team-roster'],
}

export const SHELL_BACK_HEADER_ROUTES = [
    '/player/',
    '/profile',
    '/lineup',
    '/propose-trade',
    '/claim-player',
    '/team-roster',
    '/change-password',
    '/commissioner-settings',
    '/create-league',
    '/join-league',
    '/bracket',
    '/draft',
    '/draft-room',
    '/rookie-draft-room',
] as const

export function hasShellBackHeader(pathname: string, params: { tradeId?: string | string[] } = {}) {
    if (pathname === '/trades' && (Array.isArray(params.tradeId) ? params.tradeId[0] : params.tradeId)) return true
    return SHELL_BACK_HEADER_ROUTES.some(route => route.endsWith('/')
        ? pathname.startsWith(route)
        : pathname === route || pathname.startsWith(`${route}/`))
}
