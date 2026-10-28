import { expect, it } from 'vitest'
import { assertLeagueTimeBrowserTarget } from '../e2e/league-timezone-browser.mjs'

it('allows only the private browser target', () => {
    expect(assertLeagueTimeBrowserTarget('http://127.0.0.1:58080')).toBe('http://127.0.0.1:58080')
    for (const target of ['https://example.com', 'http://127.0.0.1:57880', 'http://localhost:58080']) {
        expect(() => assertLeagueTimeBrowserTarget(target)).toThrow()
    }
})
