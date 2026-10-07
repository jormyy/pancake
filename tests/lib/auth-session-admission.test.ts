import { describe, expect, it } from 'vitest'
import { authStorageKey, inspectSession, readStoredAuth } from '@/lib/auth-session'
import { authSession, fixtureProject } from '../helpers/auth-session'

describe('cached auth admission', () => {
    it('keeps only an unexpired matching project and token subject', () => {
        const session = authSession('owner', 100)
        expect(inspectSession(session, fixtureProject, 99_999).session).toBe(session)
        expect(inspectSession(session, fixtureProject, 100_000)).toEqual({ session: null, status: 'expired' })
        expect(inspectSession({ ...session, user: { id: 'foreign', aud: 'authenticated' } }, fixtureProject, 99_999).status).toBe('invalid')
        expect(inspectSession(session, 'http://other-project.test', 99_999).status).toBe('invalid')
        expect(inspectSession({ ...session, expires_at: 200 }, fixtureProject, 99_999).status).toBe('invalid')
    })
    it.each([{}, { access_token: 'invalid', user: { id: 'owner' } }, { ...authSession('owner'), user: { id: 123, aud: 'authenticated' } }, { ...authSession('owner'), expires_at: '9999999999' }, { ...authSession('owner'), access_token: 'e30.bm90anNvbg.e30' }])('rejects malformed session %#', value => {
        expect(inspectSession(value, fixtureProject).status).toBe('invalid')
    })
    it('reads only the configured project key and treats denied or malformed storage as unavailable', () => {
        const keys: string[] = []
        const session = authSession('owner')
        expect(readStoredAuth({ getItem(key) { keys.push(key); return key === authStorageKey(fixtureProject) ? JSON.stringify(session) : null } }, fixtureProject).session).toEqual(session)
        expect(keys).toEqual(['sb-auth-fixture-auth-token'])
        expect(readStoredAuth({ getItem: () => null }, fixtureProject).status).toBe('missing')
        expect(readStoredAuth({ getItem: () => '{' }, fixtureProject).status).toBe('invalid')
        expect(readStoredAuth({ getItem: () => { throw new Error('Denied') } }, fixtureProject).status).toBe('unavailable')
    })
})
