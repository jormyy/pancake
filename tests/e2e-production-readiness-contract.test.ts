import { describe, expect, it } from 'vitest'
import {
    evaluateLegacyKeyReadiness,
    validateHostedReleaseProvenance,
} from './e2e/production-readiness-contract.mjs'
import { probeHostedReleaseProvenance } from './e2e/hosted-release-provenance.mjs'

describe('production readiness contracts', () => {
    it('never lets manual legacy-key evidence override an authoritative enabled state', () => {
        expect(evaluateLegacyKeyReadiness({
            legacyState: { ok: true, enabled: true, evidence: 'enabled' },
            legacyKeys: ['anon', 'service_role'],
            manualVerified: true,
        })).toMatchObject({ pass: false, source: 'authoritative' })
    })

    it('accepts manual legacy-key evidence only when authoritative sources are unavailable', () => {
        expect(evaluateLegacyKeyReadiness({
            legacyState: { ok: false, enabled: null, evidence: 'unavailable' },
            legacyKeys: null,
            manualVerified: true,
        })).toMatchObject({ pass: true, source: 'manual' })
        expect(evaluateLegacyKeyReadiness({
            legacyState: { ok: false, enabled: null, evidence: 'unavailable' },
            legacyKeys: ['legacy'],
            manualVerified: true,
        })).toMatchObject({ pass: false, source: 'authoritative' })
    })

    it('requires both deployed surfaces to match the intended release', () => {
        const expected = { commitSha: 'a'.repeat(40), bundleDigest: 'b'.repeat(64) }
        expect(validateHostedReleaseProvenance(expected, expected, expected)).toEqual([])
        expect(validateHostedReleaseProvenance(
            expected,
            { ...expected, commitSha: 'c'.repeat(40) },
            { ...expected, bundleDigest: 'd'.repeat(64) },
        )).toEqual(expect.arrayContaining([
            expect.stringContaining('Edge commitSha'),
            expect.stringContaining('frontend bundleDigest'),
        ]))
    })

    it('rejects malformed or missing expected release identifiers', () => {
        expect(validateHostedReleaseProvenance(
            { commitSha: 'main', bundleDigest: '' },
            {},
            {},
        )).toEqual(expect.arrayContaining([
            'expected commitSha must be a full Git SHA',
            'expected bundleDigest must be a SHA-256 digest',
        ]))
    })

    it('fails a stale deployed Edge response even when the frontend is current', async () => {
        const expected = { commitSha: 'a'.repeat(40), bundleDigest: 'b'.repeat(64) }
        const fetchImpl = async (url: string | URL | Request) => new Response(JSON.stringify(
            String(url).includes('/health')
                ? { ok: true, service: 'pancake-supabase-api', runtime: 'supabase-edge', ...expected, commitSha: 'c'.repeat(40) }
                : expected,
        ))

        const result = await probeHostedReleaseProvenance({
            expected,
            edgeApiUrl: 'https://api.example.test',
            frontendUrl: 'https://app.example.test',
            fetchImpl: fetchImpl as typeof fetch,
        })

        expect(result.failures).toContain(`Edge commitSha ${'c'.repeat(40)} does not match ${'a'.repeat(40)}`)
    })
})
