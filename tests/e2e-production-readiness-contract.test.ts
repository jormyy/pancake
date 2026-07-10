import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
    evaluateLegacyKeyReadiness,
    validInternalEdgeAuthProbe,
    validateHostedReleaseProvenance,
    validateHostedTargetIdentity,
} from './e2e/production-readiness-contract.mjs'
import { probeHostedReleaseProvenance, runHostedReleaseProvenance } from './e2e/hosted-release-provenance.mjs'

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
        const expected = {
            commitSha: 'a'.repeat(40),
            frontendBundleDigest: 'b'.repeat(64),
            edgeArtifactDigest: 'c'.repeat(64),
        }
        const edge = { commitSha: expected.commitSha, edgeArtifactDigest: expected.edgeArtifactDigest }
        const frontend = { commitSha: expected.commitSha, bundleDigest: expected.frontendBundleDigest }
        expect(validateHostedReleaseProvenance(expected, edge, frontend)).toEqual([])
        expect(validateHostedReleaseProvenance(
            expected,
            { ...edge, commitSha: 'd'.repeat(40) },
            { ...frontend, bundleDigest: 'e'.repeat(64) },
        )).toEqual(expect.arrayContaining([
            expect.stringContaining('Edge commitSha'),
            expect.stringContaining('frontend bundleDigest'),
        ]))
    })

    it('rejects malformed or missing expected release identifiers', () => {
        expect(validateHostedReleaseProvenance(
            { commitSha: 'main', frontendBundleDigest: '', edgeArtifactDigest: '' },
            {},
            {},
        )).toEqual(expect.arrayContaining([
            'expected commitSha must be a full Git SHA',
            'expected frontendBundleDigest must be a SHA-256 digest',
            'expected edgeArtifactDigest must be a SHA-256 digest',
        ]))
    })

    it('fails a stale Edge artifact even when mutable environment values claim the new release', async () => {
        const expected = {
            commitSha: 'a'.repeat(40),
            frontendBundleDigest: 'b'.repeat(64),
            edgeArtifactDigest: 'c'.repeat(64),
        }
        const fetchImpl = async (url: string | URL | Request) => new Response(JSON.stringify(
            String(url).includes('/health')
                ? {
                    ok: true,
                    service: 'pancake-supabase-api',
                    runtime: 'supabase-edge',
                    commitSha: expected.commitSha,
                    edgeArtifactDigest: 'd'.repeat(64),
                    environmentReleaseSha: expected.commitSha,
                }
                : { commitSha: expected.commitSha, bundleDigest: expected.frontendBundleDigest },
        ))

        const result = await probeHostedReleaseProvenance({
            expected,
            edgeApiUrl: 'https://api.example.test',
            frontendUrl: 'https://app.example.test',
            fetchImpl: fetchImpl as typeof fetch,
        })

        expect(result.failures).toContain(`Edge edgeArtifactDigest ${'d'.repeat(64)} does not match ${'c'.repeat(64)}`)
    })

    it('binds every hosted surface to the pinned production identity', () => {
        const projectRef = 'ceeytbfmwsnzalxlkalc'
        const valid = {
            expectedProjectRef: projectRef,
            linkedProjectRef: projectRef,
            supabaseUrl: `https://${projectRef}.supabase.co`,
            edgeApiUrl: `https://${projectRef}.supabase.co/functions/v1/api`,
            frontendUrl: 'https://pancake.example.com',
            expectedFrontendHost: 'pancake.example.com',
        }
        expect(validateHostedTargetIdentity(valid)).toEqual([])
        expect(validateHostedTargetIdentity({ ...valid, linkedProjectRef: 'a'.repeat(20) })).toContain(
            'linked Supabase project does not match the pinned production project',
        )
        expect(validateHostedTargetIdentity({ ...valid, edgeApiUrl: 'https://staging.supabase.co/functions/v1/api' })).toContain(
            'Edge API URL does not match the pinned production project',
        )
        expect(validateHostedTargetIdentity({ ...valid, frontendUrl: 'https://preview.example.com' })).toContain(
            'frontend URL does not match the pinned production host',
        )
        expect(validateHostedTargetIdentity({ ...valid, frontendUrl: 'https://preview.example.com', allowCandidateFrontend: true })).toEqual([])
    })

    it('requires the positive Edge auth probe response contract', () => {
        expect(validInternalEdgeAuthProbe({
            status: 200,
            text: JSON.stringify({ ok: true, action: '__edge_auth_probe__' }),
        })).toBe(true)
        expect(validInternalEdgeAuthProbe({ status: 404, text: '{}' })).toBe(false)
        expect(validInternalEdgeAuthProbe({ status: 200, text: JSON.stringify({ ok: true }) })).toBe(false)
        expect(validInternalEdgeAuthProbe({ status: 200, text: 'not-json' })).toBe(false)
    })

    it('retains a BLOCKED hosted report when probes fail', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'pancake-hosted-provenance-'))
        const reportPath = path.join(root, 'report.md')
        const projectRef = 'ceeytbfmwsnzalxlkalc'
        try {
            const result = await runHostedReleaseProvenance({
                expected: {
                    commitSha: 'a'.repeat(40),
                    frontendBundleDigest: 'b'.repeat(64),
                    edgeArtifactDigest: 'c'.repeat(64),
                },
                edgeApiUrl: `https://${projectRef}.supabase.co/functions/v1/api`,
                frontendUrl: 'https://pancake.example.com',
                target: {
                    expectedProjectRef: projectRef,
                    linkedProjectRef: projectRef,
                    supabaseUrl: `https://${projectRef}.supabase.co`,
                    edgeApiUrl: `https://${projectRef}.supabase.co/functions/v1/api`,
                    frontendUrl: 'https://pancake.example.com',
                    expectedFrontendHost: 'pancake.example.com',
                },
                fetchImpl: async () => { throw new Error('connection refused') },
                reportPath,
            })
            expect(result.failures).toEqual(expect.arrayContaining([
                expect.stringContaining('Edge probe failed'),
                expect.stringContaining('frontend probe failed'),
            ]))
            expect(await readFile(reportPath, 'utf8')).toContain('| Edge | BLOCKED |')
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})
