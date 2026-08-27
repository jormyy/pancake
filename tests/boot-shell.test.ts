import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    StyleSheet: { create: (styles: unknown) => styles, flatten: (style: unknown) => style },
}))

const {
    BOOT_SHELL_CSS,
    BOOT_SHELL_HTML,
    BOOT_SHELL_ID,
    BOOT_SHELL_READY_ATTR,
    BOOT_SHELL_SCRIPT,
} = await import('@/constants/boot-shell')

// The boot shell is emitted as a raw string into the document, so nothing type
// checks it. A single lost escape once left the whole script unparsable, which
// silently disabled the instant paint while every other gate stayed green.
describe('boot shell', () => {
    it('emits a script the browser can actually parse', () => {
        expect(() => new Function(BOOT_SHELL_SCRIPT)).not.toThrow()
    })

    it('reveals the shell only for a stored session on a non-auth route', () => {
        const run = (pathname: string, storage: Record<string, string>) => {
            const element = {
                attributes: {} as Record<string, string>,
                setAttribute(name: string, value: string) { this.attributes[name] = value },
                querySelectorAll: () => [] as unknown[],
            }
            const keys = Object.keys(storage)
            const scope = {
                document: {
                    getElementById: (id: string) => (id === BOOT_SHELL_ID ? element : null),
                    documentElement: { setAttribute: () => {} },
                },
                location: { pathname },
                window: {
                    localStorage: {
                        length: keys.length,
                        key: (index: number) => keys[index] ?? null,
                        getItem: (key: string) => storage[key] ?? null,
                    },
                },
            }
            new Function('document', 'location', 'window', BOOT_SHELL_SCRIPT)(
                scope.document, scope.location, scope.window,
            )
            return element.attributes
        }

        const session = JSON.stringify({ access_token: 'fake-access-token', user: { id: 'user-1' } })

        expect(run('/', { 'sb-abc-auth-token': session })).toMatchObject({
            'data-visible': '1',
            [BOOT_SHELL_READY_ATTR]: '1',
        })
        // Signed out: the app boots to a marketing/auth screen, not the chrome.
        expect(run('/', {})).toEqual({})
        // Signed in but heading to auth: that screen owns the whole viewport.
        expect(run('/sign-in', { 'sb-abc-auth-token': session })).toEqual({})
        // Corrupt storage entry must not break the launch.
        expect(run('/', { 'sb-abc-auth-token': '{not json' })).toEqual({})
    })

    it('renders the cached league, team, and initials the app will render', () => {
        const texts: Record<string, string> = {}
        const node = (name: string) => ({
            set textContent(value: string) { texts[name] = value },
            removeAttribute: () => {},
        })
        const element = {
            attributes: {} as Record<string, string>,
            setAttribute(key: string, value: string) { this.attributes[key] = value },
            querySelectorAll: (selector: string) => {
                const match = /\[data-pbs="([^"]+)"\]/.exec(selector)
                return match ? [node(match[1])] : []
            },
            querySelector: () => ({ removeAttribute: () => {} }),
        }
        const storage: Record<string, string> = {
            'sb-abc-auth-token': JSON.stringify({ access_token: 't', user: { id: 'u1' } }),
            'pancake:league-memberships:v1:u1': JSON.stringify({
                version: 1,
                savedAt: 0,
                value: [{ id: 'm1', role: 'commissioner', team_name: 'E2E Team 1', leagues: { id: 'l1', name: 'Sunday Dynasty' } }],
            }),
            'pancake:selected-league:v1:u1': JSON.stringify({ version: 1, savedAt: 0, value: 'm1' }),
        }
        const keys = Object.keys(storage)
        new Function('document', 'location', 'window', BOOT_SHELL_SCRIPT)(
            {
                getElementById: (id: string) => (id === BOOT_SHELL_ID ? element : null),
                documentElement: { setAttribute: () => {} },
            },
            { pathname: '/roster' },
            {
                localStorage: {
                    length: keys.length,
                    key: (index: number) => keys[index] ?? null,
                    getItem: (key: string) => storage[key] ?? null,
                },
            },
        )
        expect(texts).toEqual({ league: 'Sunday Dynasty', team: 'E2E Team 1', crest: 'S', initials: 'ET' })
    })

    it('links every primary route so the shell navigates without the bundle', () => {
        for (const href of ['/', '/roster', '/players', '/trades', '/dynasty', '/league']) {
            expect(BOOT_SHELL_HTML).toContain(`data-href="${href}"`)
            expect(BOOT_SHELL_HTML).toContain(`href="${href}"`)
        }
    })

    it('keeps the shell hidden until the script opts it in', () => {
        expect(BOOT_SHELL_CSS).toContain(`#${BOOT_SHELL_ID}{`)
        expect(BOOT_SHELL_CSS).toContain('display:none')
        expect(BOOT_SHELL_CSS).toContain(`#${BOOT_SHELL_ID}[data-visible="1"]{display:block;}`)
    })
})
