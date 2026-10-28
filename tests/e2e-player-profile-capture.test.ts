import { expect, it } from 'vitest'
import { summarizeProfileRequests } from './e2e/player-profile-capture.mjs'
import { privateProfileEnvironment } from './e2e/player-profile-local-setup.mjs'

it('separates profile payload bytes from shell and refresh requests', () => {
    expect(summarizeProfileRequests([
        { path: '/functions/v1/api/views/player', bytes: 400 },
        { path: '/functions/v1/api/version', bytes: 70 },
        { path: '/rest/v1/league_members', bytes: 20 },
    ])).toMatchObject({ count: 3, bytes: 490, viewCount: 1, viewBytes: 400 })
    expect(summarizeProfileRequests([])).toMatchObject({ count: 0, bytes: 0, viewCount: 0, viewBytes: 0 })
})

it('rejects every endpoint except the private profile stack', () => {
    expect(() => privateProfileEnvironment({ API_URL: 'https://example.test' })).toThrow()
    expect(privateProfileEnvironment({ API_URL: 'http://127.0.0.1:57721' })).toMatchObject({
        EXPO_PUBLIC_API_URL: 'http://127.0.0.1:57721/functions/v1/api', E2E_FRONTEND_URL: 'http://127.0.0.1:57780',
    })
})
